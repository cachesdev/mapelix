import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodePng } from "@mapelix/prototype/png";

import { openMapWorld } from "../index.js";
import { createOverviewTile, type OverviewSourceTile } from "../overview.js";
import { MAP_TILE_SIZE } from "../../tile-grid.js";
import type { RenderedTile, TileCoordinates } from "../../types.js";
import { jsonBytes, rendererIdentity, sha256, sourceIdentity } from "./identity.js";
import { generationId, publishedManifest, verifyGeneration } from "./manifest.js";
import { assertNoLinks, assertTreeNoLinks, ownedPath, removeOwnedTree } from "./paths.js";
import {
  changedChunks,
  dirtyTiles,
  isTileReusable,
  loadPreviousGeneration,
  readChunkFingerprints,
  sourceChunksBytes,
  sourceChunksIdentity,
  type PreviousGeneration,
} from "./incremental.js";
import { createBatchPlan, tilePath } from "./plan.js";
import type {
  BatchManifest,
  BatchTile,
  BatchUpdate,
  BatchWorkerInput,
  PreparedBatch,
} from "./types.js";

export const SURFACE_CACHE_DIRECTORY = ".mapelix-surface-cache";

/** Creates the owned surface cache directory and rejects links anywhere below it. */
async function prepareSurfaceCache(output: string): Promise<string> {
  const directory = ownedPath(output, SURFACE_CACHE_DIRECTORY);
  try {
    await mkdir(directory);
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }
  await assertTreeNoLinks(directory);
  return directory;
}

/** Runs only in the supervised coordinator; no publication can occur from this worker. */
export async function prepareBatch(
  input: BatchWorkerInput,
  controller: AbortController,
): Promise<PreparedBatch> {
  const { batch, stage } = input;
  const { signal } = controller;
  const source = await sourceIdentity(batch.world, batch.limits.maxInputFileBytes, signal);
  const renderer = await rendererIdentity();
  signal.throwIfAborted();
  const surfaceCache =
    batch.surfaceCacheMiB > 0
      ? {
          directory: await prepareSurfaceCache(batch.output),
          // Chunk position, dimension, surface range and style are added by the renderer.
          namespace: jsonBytes({
            revision: renderer.revision,
            appearanceSha256: renderer.appearanceSha256,
            appearance: batch.appearance,
            biomeBlendRadius: batch.biomeBlendRadius,
          }),
          maxMiB: batch.surfaceCacheMiB,
        }
      : undefined;
  signal.throwIfAborted();
  const world = await openMapWorld({
    directory: batch.world,
    renderConcurrency: batch.limits.workers,
    forceWorkers: true,
    chunkFingerprints: true,
    ...(surfaceCache === undefined ? {} : { surfaceCache }),
    signal,
  });
  const abort = () => {
    void world.close({ abort: true }).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const plan = createBatchPlan(world, batch);
    const header: Pick<BatchManifest, "renderer" | "resources" | "grid" | "render"> = {
      renderer: { name: "@mapelix/core", version: "0.0.0", revision: renderer.revision },
      resources: { appearanceSha256: renderer.appearanceSha256 },
      grid: {
        scheme: "xyz",
        tileSize: 256,
        xAxis: "east",
        yAxis: "south",
        pixelsPerBlock: "2^zoom",
        zooms: batch.zooms,
        ...(batch.zooms.some((z) => z < 0)
          ? { overview: { sourceZoom: 0 as const, filter: "area-premultiplied-srgb-v1" as const } }
          : {}),
      },
      render: {
        profiles: batch.profiles,
        appearance: batch.appearance,
        shadows: batch.shadows,
        biomeBlendRadius: batch.biomeBlendRadius,
        correctReferenceBugs: batch.correctReferenceBugs,
        bounds: batch.bounds,
      },
    };
    const chunks = readChunkFingerprints(
      world,
      batch.profiles.map((profile) => profile.dimension),
    );
    let previous: PreviousGeneration | undefined;
    let reason: string | undefined;
    let dirty = new Set<string>();
    let changedChunkCount = 0;
    if (batch.incremental) {
      const loaded =
        chunks === undefined
          ? "world has no chunk fingerprints"
          : await loadPreviousGeneration(batch, header, signal);
      if (typeof loaded === "string") reason = loaded;
      else {
        previous = loaded;
        const changed = changedChunks(loaded.chunks, chunks!);
        for (const rows of changed.values()) changedChunkCount += rows.length;
        dirty = dirtyTiles(changed, batch);
      }
    }
    const reusable = (tile: TileCoordinates): BatchTile | undefined =>
      isTileReusable(previous, dirty, tile);
    let renderedTiles = 0;
    let composedOverviews = 0;
    let reusedTiles = 0;
    const published = new Map(plan.tiles.map((tile, index) => [tilePath(tile), index]));
    const tiles: BatchTile[] = [];
    let pngBytes = 0;
    let generatedPngBytes = 0;
    let temporaryPngBytes = 0;
    const scratchName = ".mapelix-overview-inputs";
    const storedPath = (tile: TileCoordinates): string =>
      published.has(tilePath(tile)) ? tilePath(tile) : `${scratchName}/${tilePath(tile)}`;
    const writePng = async (coordinates: TileCoordinates, png: Uint8Array): Promise<void> => {
      signal.throwIfAborted();
      generatedPngBytes += png.byteLength;
      if (generatedPngBytes > batch.limits.maxOutputBytes)
        throw new RangeError("PNG output including overview sources exceeds maxOutputBytes");
      const key = tilePath(coordinates);
      const index = published.get(key);
      if (index === undefined) temporaryPngBytes += png.byteLength;
      else pngBytes += png.byteLength;
      const destination = ownedPath(stage, storedPath(coordinates));
      await mkdir(dirname(destination), { recursive: true });
      await assertNoLinks(destination, true);
      signal.throwIfAborted();
      await writeFile(destination, png, { flag: "wx", signal });
      if (index !== undefined)
        tiles[index] = {
          ...coordinates,
          path: key,
          bytes: png.byteLength,
          sha256: sha256(png),
        };
    };
    const writeTile = async (tile: RenderedTile): Promise<void> => {
      if (tile.width !== MAP_TILE_SIZE || tile.height !== MAP_TILE_SIZE)
        throw new Error("Renderer returned an invalid tile size");
      await writePng(tile.coordinates, tile.png);
    };
    /** Copies an unchanged tile from the published generation after checking its digest. */
    const reuseTiles = async (jobs: readonly TileCoordinates[]): Promise<void> => {
      for (const coordinates of jobs) {
        const stored = reusable(coordinates)!;
        const path = ownedPath(previous!.directory, stored.path);
        await assertNoLinks(path);
        const png = await readFile(path, { signal });
        if (png.byteLength !== stored.bytes || sha256(png) !== stored.sha256)
          throw new Error(`Previous generation tile mismatch: ${stored.path}`);
        await writePng(coordinates, png);
        reusedTiles += 1;
      }
    };
    const run = async (
      jobs: readonly TileCoordinates[],
      render: (coordinates: TileCoordinates) => Promise<RenderedTile>,
      spatial = false,
    ): Promise<void> => {
      const lanes = Math.min(jobs.length, batch.limits.maxPending);
      const bands = spatial ? spatialBands(jobs, lanes) : [[...jobs]];
      let failure: unknown;
      const renderNext = async (lane: number): Promise<void> => {
        try {
          for (let job = nextJob(bands, lane); job !== undefined; job = nextJob(bands, lane)) {
            signal.throwIfAborted();
            await writeTile(await render(job));
          }
        } catch (cause) {
          failure ??= cause;
          controller.abort(cause);
        }
      };
      await Promise.all(Array.from({ length: lanes }, (_, lane) => renderNext(lane)));
      if (failure !== undefined) throw failure;
      signal.throwIfAborted();
    };
    const nativeTiles = plan.tiles.filter((tile) => tile.z >= 0);
    await reuseTiles(nativeTiles.filter((tile) => reusable(tile) !== undefined));
    // Hidden zoom-0 overview sources are not published, so they are always rendered.
    const nativeJobs = [
      ...nativeTiles.filter((tile) => reusable(tile) === undefined),
      ...plan.temporary,
    ];
    renderedTiles = nativeJobs.length;
    await run(
      nativeJobs,
      (coordinates) => {
        const profile = batch.profiles.find((value) => value.dimension === coordinates.dimension)!;
        return world.renderTile(coordinates, {
          topY: profile.topY,
          appearance: batch.appearance,
          shadows: batch.shadows !== "off",
          biomeBlendRadius: batch.biomeBlendRadius,
          correctReferenceBugs: batch.correctReferenceBugs,
        });
      },
      true,
    );
    // Overview composition only reads the completed PNGs; release native workers first.
    // Closing also writes newly extracted surfaces to the surface cache.
    await world.close();
    const surfaceCacheStats = world.getSurfaceCacheStats?.();
    const overviewTiles = plan.tiles.filter((tile) => tile.z < 0);
    await reuseTiles(overviewTiles.filter((tile) => reusable(tile) !== undefined));
    const overviewJobs = overviewTiles.filter((tile) => reusable(tile) === undefined);
    composedOverviews = overviewJobs.length;
    await run(overviewJobs, (coordinates) => {
      async function* sources(): AsyncGenerator<OverviewSourceTile> {
        for (const source of plan.overviewSources.get(tilePath(coordinates)) ?? []) {
          signal.throwIfAborted();
          const path = ownedPath(stage, storedPath(source));
          await assertNoLinks(path);
          const png = await readFile(path, { signal });
          yield { coordinates: source, rgba: decodePng(png, MAP_TILE_SIZE, MAP_TILE_SIZE) };
        }
      }
      return createOverviewTile(coordinates, sources(), signal);
    });
    if (plan.temporary.length > 0) await removeOwnedTree(stage, ownedPath(stage, scratchName));
    signal.throwIfAborted();
    const after = await sourceIdentity(batch.world, batch.limits.maxInputFileBytes, signal);
    if (after.revision !== source.revision)
      throw new Error("Source snapshot changed during rendering");
    const sourceChunks = chunks === undefined ? undefined : sourceChunksBytes(chunks);
    if (sourceChunks !== undefined)
      await writeFile(ownedPath(stage, sourceChunksIdentity(sourceChunks).path), sourceChunks, {
        flag: "wx",
        signal,
      });
    const manifest: BatchManifest = {
      format: "mapelix-2d",
      schemaVersion: 1,
      complete: true,
      renderer: header.renderer,
      resources: header.resources,
      source,
      grid: header.grid,
      render: header.render,
      tileCount: tiles.length,
      pngBytes,
      tiles,
      ...(sourceChunks === undefined ? {} : { sourceChunks: sourceChunksIdentity(sourceChunks) }),
      ...(batch.zooms.some((z) => z < 0)
        ? {
            work: {
              tileJobs: plan.tiles.length + plan.temporary.length,
              temporaryTiles: plan.temporary.length,
              temporaryPngBytes,
            },
          }
        : {}),
    };
    const generation = generationId(manifest);
    const bytes = jsonBytes(manifest);
    const publicationBytes =
      generatedPngBytes +
      Buffer.byteLength(sourceChunks ?? "") +
      Buffer.byteLength(bytes) +
      Buffer.byteLength(jsonBytes(publishedManifest(manifest, generation)));
    if (publicationBytes > batch.limits.maxOutputBytes)
      throw new RangeError("Manifest and PNG output exceeds maxOutputBytes");
    await writeFile(ownedPath(stage, "manifest.json"), bytes, { flag: "wx", signal });
    await verifyGeneration(stage, manifest, signal);
    const update: BatchUpdate = {
      mode: previous === undefined ? "full" : "incremental",
      ...(reason === undefined ? {} : { reason }),
      ...(previous === undefined ? {} : { previousGeneration: previous.generation }),
      changedChunks: changedChunkCount,
      renderedTiles,
      composedOverviews,
      reusedTiles,
      ...(surfaceCacheStats === undefined ? {} : { surfaceCache: surfaceCacheStats }),
    };
    return { manifest, generation, publicationBytes, update };
  } finally {
    signal.removeEventListener("abort", abort);
    await world.close({ abort: signal.aborted });
  }
}

/**
 * Orders native tiles by dimension and zoom-0 area (north to south, west to east), then by zoom,
 * and splits them into contiguous bands, one per concurrent lane. Neighbouring tiles and the
 * native zooms of one area then reach the same renderer while its caches still hold them.
 */
export function spatialBands(jobs: readonly TileCoordinates[], lanes: number): TileCoordinates[][] {
  const area = (tile: TileCoordinates, axis: "x" | "y"): number =>
    tile.z > 0 ? Math.floor(tile[axis] / 2 ** tile.z) : tile[axis];
  const ordered = [...jobs].sort(
    (left, right) =>
      left.dimension.localeCompare(right.dimension) ||
      area(left, "y") - area(right, "y") ||
      area(left, "x") - area(right, "x") ||
      left.z - right.z ||
      left.y - right.y ||
      left.x - right.x,
  );
  return Array.from({ length: lanes }, (_, lane) =>
    ordered.slice(
      Math.floor((ordered.length * lane) / lanes),
      Math.floor((ordered.length * (lane + 1)) / lanes),
    ),
  );
}

/** Takes the next job of the band of a lane, or else the last job of the largest band. */
export function nextJob(bands: TileCoordinates[][], lane: number): TileCoordinates | undefined {
  const job = bands[lane % bands.length]!.shift();
  if (job !== undefined) return job;
  let largest: TileCoordinates[] | undefined;
  for (const band of bands) if (band.length > (largest?.length ?? 0)) largest = band;
  return largest?.pop();
}
