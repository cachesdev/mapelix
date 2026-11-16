import { readFile } from "node:fs/promises";
import { tileDependencyBounds } from "@mapelix/prototype";

import { mapTileAncestor } from "../../tile-grid.js";
import type { Dimension, MapWorld, TileCoordinates } from "../../types.js";
import { identifyFile, jsonBytes, sha256 } from "./identity.js";
import { generationId } from "./manifest.js";
import { assertNoLinks, isMissing, ownedPath } from "./paths.js";
import { tilePath } from "./plan.js";
import type { BatchManifest, BatchTile, NormalizedBatch } from "./types.js";

export const SOURCE_CHUNKS_PATH = "source-chunks.json";

/** Per-dimension chunk fingerprints, keyed `x,z`. */
export type ChunkFingerprints = ReadonlyMap<Dimension, ReadonlyMap<string, string>>;

export interface SourceChunksFile {
  readonly format: "mapelix-2d-source-chunks";
  readonly schemaVersion: 1;
  /** Sorted `[chunkX, chunkZ, fingerprint]` rows per rendered dimension. */
  readonly dimensions: Readonly<Record<string, readonly (readonly [number, number, string])[]>>;
}

export interface PreviousGeneration {
  readonly directory: string;
  readonly generation: string;
  readonly manifest: BatchManifest;
  readonly tiles: ReadonlyMap<string, BatchTile>;
  readonly chunks: ChunkFingerprints;
}

export function readChunkFingerprints(
  world: Pick<MapWorld, "getChunkFingerprints">,
  dimensions: readonly Dimension[],
): ChunkFingerprints | undefined {
  if (world.getChunkFingerprints === undefined) return undefined;
  return new Map(
    dimensions.map((dimension) => [dimension, world.getChunkFingerprints!(dimension)]),
  );
}

export function sourceChunksFile(chunks: ChunkFingerprints): SourceChunksFile {
  const dimensions: Record<string, (readonly [number, number, string])[]> = {};
  for (const [dimension, fingerprints] of [...chunks].sort(([a], [b]) => a.localeCompare(b))) {
    dimensions[dimension] = [...fingerprints]
      .map(([key, value]): readonly [number, number, string] => {
        const [x, z] = key.split(",").map(Number);
        return [x!, z!, value];
      })
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  return { format: "mapelix-2d-source-chunks", schemaVersion: 1, dimensions };
}

/**
 * Loads the published generation when it was rendered with the same renderer, resources, grid
 * and render settings. Returns a reason string when a full render is required instead.
 */
export async function loadPreviousGeneration(
  batch: NormalizedBatch,
  current: Pick<BatchManifest, "renderer" | "resources" | "grid" | "render">,
  signal: AbortSignal,
): Promise<PreviousGeneration | string> {
  let pointer: unknown;
  try {
    const path = ownedPath(batch.output, "manifest.json");
    await assertNoLinks(path);
    pointer = JSON.parse(await readFile(path, { encoding: "utf8", signal }));
  } catch (cause) {
    if (isMissing(cause)) return "no published generation";
    throw cause;
  }
  const generation = Reflect.get(pointer as object, "generation");
  if (typeof generation !== "string" || !/^[a-f0-9]{64}$/.test(generation))
    return "unsupported published manifest";
  const directory = ownedPath(batch.output, "generations", generation);
  let manifest: BatchManifest;
  try {
    const path = ownedPath(directory, "manifest.json");
    await assertNoLinks(path);
    manifest = JSON.parse(await readFile(path, { encoding: "utf8", signal })) as BatchManifest;
  } catch (cause) {
    if (isMissing(cause)) return "published generation is missing";
    throw cause;
  }
  if (generationId(manifest) !== generation) return "published generation manifest mismatch";
  if (manifest.renderer.revision !== current.renderer.revision) return "renderer changed";
  if (manifest.resources.appearanceSha256 !== current.resources.appearanceSha256)
    return "appearance resources changed";
  if (jsonBytes(manifest.grid) !== jsonBytes(current.grid)) return "tile grid changed";
  if (jsonBytes(manifest.render) !== jsonBytes(current.render)) return "render settings changed";
  if (manifest.sourceChunks === undefined) return "previous generation has no source chunk index";
  const sourcePath = ownedPath(directory, manifest.sourceChunks.path);
  const stored = await identifyFile(
    sourcePath,
    manifest.sourceChunks.path,
    manifest.sourceChunks.bytes,
    signal,
  );
  if (stored.sha256 !== manifest.sourceChunks.sha256) return "source chunk index mismatch";
  const file = JSON.parse(await readFile(sourcePath, "utf8")) as SourceChunksFile;
  if (file.format !== "mapelix-2d-source-chunks" || file.schemaVersion !== 1)
    return "unsupported source chunk index";
  const chunks = new Map<Dimension, Map<string, string>>();
  for (const { dimension } of batch.profiles) {
    const rows = file.dimensions[dimension];
    if (rows === undefined) return `previous generation has no ${dimension} chunk index`;
    chunks.set(dimension, new Map(rows.map(([x, z, value]) => [`${x},${z}`, value])));
  }
  return {
    directory,
    generation,
    manifest,
    tiles: new Map(manifest.tiles.map((tile) => [tile.path, tile])),
    chunks,
  };
}

/** Chunks whose records changed, appeared or were deleted, per dimension. */
export function changedChunks(
  previous: ChunkFingerprints,
  current: ChunkFingerprints,
): Map<Dimension, (readonly [number, number])[]> {
  const changed = new Map<Dimension, (readonly [number, number])[]>();
  for (const [dimension, now] of current) {
    const before = previous.get(dimension) ?? new Map<string, string>();
    const keys = new Set([...before.keys(), ...now.keys()]);
    const rows: (readonly [number, number])[] = [];
    for (const key of keys) {
      if (before.get(key) === now.get(key)) continue;
      const [x, z] = key.split(",").map(Number);
      rows.push([x!, z!]);
    }
    changed.set(dimension, rows);
  }
  return changed;
}

/**
 * Tiles whose pixels may change: native tiles whose dependency bounds (surface input, shadow
 * halo, biome-blend window) intersect a changed chunk, and overview tiles above a changed
 * zoom-0 tile. Zoom 0 is always evaluated because overviews are composed from it.
 */
export function dirtyTiles(
  changed: ReadonlyMap<Dimension, readonly (readonly [number, number])[]>,
  batch: Pick<NormalizedBatch, "zooms" | "shadows" | "biomeBlendRadius">,
): Set<string> {
  const dirty = new Set<string>();
  const options = { shadows: batch.shadows !== "off", biomeBlendRadius: batch.biomeBlendRadius };
  const nativeZooms = [...new Set([0, ...batch.zooms.filter((z) => z >= 0)])];
  const overviewZooms = batch.zooms.filter((z) => z < 0);
  for (const [dimension, chunks] of changed) {
    for (const z of nativeZooms) {
      const span = 256 / 2 ** z;
      const probe = tileDependencyBounds({ dimension, z, x: 0, y: 0 }, options);
      const before = -probe.minX;
      const after = probe.maxX - span;
      const beforeZ = -probe.minZ;
      const afterZ = probe.maxZ - span;
      for (const [chunkX, chunkZ] of chunks) {
        const minX = chunkX * 16;
        const minZ = chunkZ * 16;
        // Tile t depends on [t*span - before, (t+1)*span + after); keep tiles intersecting the chunk.
        const fromX = Math.floor((minX - after) / span);
        const toX = Math.ceil((minX + 16 + before) / span) - 1;
        const fromY = Math.floor((minZ - afterZ) / span);
        const toY = Math.ceil((minZ + 16 + beforeZ) / span) - 1;
        for (let y = fromY; y <= toY; y += 1) {
          for (let x = fromX; x <= toX; x += 1) {
            const tile = { dimension, z, x, y };
            dirty.add(tilePath(tile));
            if (z !== 0) continue;
            for (const zoom of overviewZooms) dirty.add(tilePath(mapTileAncestor(tile, zoom)));
          }
        }
      }
    }
  }
  return dirty;
}

export function sourceChunksBytes(chunks: ChunkFingerprints): string {
  return jsonBytes(sourceChunksFile(chunks));
}

export function sourceChunksIdentity(bytes: string): {
  path: string;
  bytes: number;
  sha256: string;
} {
  return { path: SOURCE_CHUNKS_PATH, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) };
}

export function isTileReusable(
  previous: PreviousGeneration | undefined,
  dirty: ReadonlySet<string>,
  tile: TileCoordinates,
): BatchTile | undefined {
  if (previous === undefined) return undefined;
  const path = tilePath(tile);
  return dirty.has(path) ? undefined : previous.tiles.get(path);
}
