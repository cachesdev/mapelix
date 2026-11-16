import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodePng } from "@mapelix/prototype/png";

import { openMapWorld } from "../index.js";
import { createOverviewTile, type OverviewSourceTile } from "../overview.js";
import { MAP_TILE_SIZE } from "../../tile-grid.js";
import type { RenderedTile, TileCoordinates } from "../../types.js";
import { jsonBytes, rendererIdentity, sha256, sourceIdentity } from "./identity.js";
import { generationId, publishedManifest, verifyGeneration } from "./manifest.js";
import { assertNoLinks, ownedPath, removeOwnedTree } from "./paths.js";
import { createBatchPlan, tilePath } from "./plan.js";
import type { BatchManifest, BatchTile, BatchWorkerInput, PreparedBatch } from "./types.js";

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
  const world = await openMapWorld({
    directory: batch.world,
    renderConcurrency: batch.limits.workers,
    forceWorkers: true,
    signal,
  });
  const abort = () => {
    void world.close({ abort: true }).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const plan = createBatchPlan(world, batch);
    const published = new Map(plan.tiles.map((tile, index) => [tilePath(tile), index]));
    const tiles: BatchTile[] = [];
    let pngBytes = 0;
    let generatedPngBytes = 0;
    let temporaryPngBytes = 0;
    const scratchName = ".mapelix-overview-inputs";
    const storedPath = (tile: TileCoordinates): string =>
      published.has(tilePath(tile)) ? tilePath(tile) : `${scratchName}/${tilePath(tile)}`;
    const writeTile = async (tile: RenderedTile): Promise<void> => {
      signal.throwIfAborted();
      if (tile.width !== MAP_TILE_SIZE || tile.height !== MAP_TILE_SIZE)
        throw new Error("Renderer returned an invalid tile size");
      generatedPngBytes += tile.png.byteLength;
      if (generatedPngBytes > batch.limits.maxOutputBytes)
        throw new RangeError("PNG output including overview sources exceeds maxOutputBytes");
      const key = tilePath(tile.coordinates);
      const index = published.get(key);
      if (index === undefined) temporaryPngBytes += tile.png.byteLength;
      else pngBytes += tile.png.byteLength;
      const destination = ownedPath(stage, storedPath(tile.coordinates));
      await mkdir(dirname(destination), { recursive: true });
      await assertNoLinks(destination, true);
      signal.throwIfAborted();
      await writeFile(destination, tile.png, { flag: "wx", signal });
      if (index !== undefined)
        tiles[index] = {
          ...tile.coordinates,
          path: key,
          bytes: tile.png.byteLength,
          sha256: sha256(tile.png),
        };
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
    await run(
      [...plan.tiles.filter((tile) => tile.z >= 0), ...plan.temporary],
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
    await world.close();
    await run(
      plan.tiles.filter((tile) => tile.z < 0),
      (coordinates) => {
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
      },
    );
    if (plan.temporary.length > 0) await removeOwnedTree(stage, ownedPath(stage, scratchName));
    signal.throwIfAborted();
    const after = await sourceIdentity(batch.world, batch.limits.maxInputFileBytes, signal);
    if (after.revision !== source.revision)
      throw new Error("Source snapshot changed during rendering");
    const manifest: BatchManifest = {
      format: "mapelix-2d",
      schemaVersion: 1,
      complete: true,
      renderer: { name: "@mapelix/core", version: "0.0.0", revision: renderer.revision },
      resources: { appearanceSha256: renderer.appearanceSha256 },
      source,
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
      tileCount: tiles.length,
      pngBytes,
      tiles,
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
      Buffer.byteLength(bytes) +
      Buffer.byteLength(jsonBytes(publishedManifest(manifest, generation)));
    if (publicationBytes > batch.limits.maxOutputBytes)
      throw new RangeError("Manifest and PNG output exceeds maxOutputBytes");
    await writeFile(ownedPath(stage, "manifest.json"), bytes, { flag: "wx", signal });
    await verifyGeneration(stage, manifest, signal);
    return { manifest, generation, publicationBytes };
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
