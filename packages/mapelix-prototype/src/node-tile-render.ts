import { readLevelDbRecords, type NamedLevelDbFile } from "./bedrock/record-source.js";
import { readLevelDbSnapshotFile, type LevelDbSnapshotFile } from "./node-leveldb.js";
import type { RenderedTile, TileCoordinates } from "./tile.js";
import type { SurfaceRange } from "./surface-range.js";
import type { SurfaceStyle } from "./surface-style.js";
import type { SurfaceStoreJob, SurfaceStoreReader } from "./chunk-surface-store.js";
import type { TileRenderCache } from "./tile-render-cache.js";
import {
  chunkHasBiomeScope,
  createBedrockWorld,
  renderRecordTile,
  type ChunkSurface,
  type EffectiveBedrockRecord,
  type RenderTileOptions,
} from "./world.js";

export interface PackedKeyGroup {
  readonly bytes: Uint8Array;
  readonly keyLength: number;
}

export interface IndexedTileSource extends LevelDbSnapshotFile {
  readonly keyGroups: readonly PackedKeyGroup[];
}

export interface IndexedTileRenderJob {
  readonly coordinates: TileCoordinates;
  readonly databaseDirectory: string;
  readonly sources: readonly IndexedTileSource[];
  readonly biomeRecords: readonly EffectiveBedrockRecord[];
  readonly surfaceRange?: SurfaceRange;
  readonly surfaceStyle?: SurfaceStyle;
  /**
   * Identifies the dimension, surface range and surface style of this job. Jobs with the same key
   * may share cached chunk surfaces; omit it to disable surface reuse.
   */
  readonly cacheKey?: string;
  /** Optional on-disk surface store view; requires `cacheKey` and an enabled memory cache. */
  readonly surfaceStore?: SurfaceStoreJob;
  readonly options?: Pick<
    RenderTileOptions,
    "shadows" | "biomeBlendRadius" | "correctReferenceBugs" | "includeSurface"
  >;
}

export async function renderIndexedTile(
  job: IndexedTileRenderJob,
  options: RenderTileOptions = {},
  signal?: AbortSignal,
  cache?: TileRenderCache,
  store?: SurfaceStoreReader,
): Promise<RenderedTile> {
  signal?.throwIfAborted();
  const records: EffectiveBedrockRecord[] = job.biomeRecords.map((record) => {
    const value = new Uint8Array(512 + record.value.byteLength);
    value.set(record.value, 512);
    return { key: record.key, value };
  });
  const renderOptions: RenderTileOptions = {
    ...job.options,
    ...options,
    ...(job.surfaceRange === undefined ? {} : { surfaceRange: job.surfaceRange }),
    ...(job.surfaceStyle === undefined ? {} : { surfaceStyle: job.surfaceStyle }),
  };
  const useCache =
    cache?.enabled === true && job.cacheKey !== undefined && renderOptions.includeSurface !== true;
  // Surfaces found now are pinned for this render, so eviction during the render cannot drop them.
  const pinned = new Map<string, ChunkSurface>();
  const surfaceKey = (chunkX: number, chunkZ: number, scoped: boolean): string =>
    `${job.cacheKey}|${chunkX},${chunkZ}|${scoped ? 1 : 0}`;
  const stored = useCache && store !== undefined ? job.surfaceStore : undefined;
  // Chunks already looked up in the disk store during this render and not found there.
  const extract = new Set<string>();

  for (const source of job.sources) {
    const keys = new Set<string>();
    for (const group of source.keyGroups) {
      const view = new DataView(group.bytes.buffer, group.bytes.byteOffset, group.bytes.byteLength);
      for (let offset = 0; offset < group.bytes.byteLength; offset += group.keyLength) {
        if (useCache) {
          const chunkX = view.getInt32(offset, true);
          const chunkZ = view.getInt32(offset + 4, true);
          const key = surfaceKey(
            chunkX,
            chunkZ,
            chunkHasBiomeScope(job.coordinates, chunkX, chunkZ),
          );
          if (pinned.has(key)) continue;
          const surface = cache!.getSurface(key);
          if (surface !== undefined) {
            pinned.set(key, surface);
            continue;
          }
          if (stored !== undefined && !extract.has(key)) {
            const scoped = chunkHasBiomeScope(job.coordinates, chunkX, chunkZ);
            const loaded = await store!.lookup(stored, chunkX, chunkZ, scoped, signal);
            if (loaded !== undefined) {
              cache!.setSurface(key, loaded);
              pinned.set(key, loaded);
              continue;
            }
            extract.add(key);
          }
        }
        keys.add(hex(group.bytes.subarray(offset, offset + group.keyLength)));
      }
    }
    if (keys.size === 0) continue;
    if (useCache) {
      const fileRecords = await cache!.fileRecords(
        job.databaseDirectory,
        source,
        keys,
        hex,
        signal,
      );
      for (const key of keys) {
        const value = fileRecords.get(key);
        if (value !== undefined) records.push({ key: unhex(key), value });
      }
      continue;
    }
    const file: NamedLevelDbFile = {
      name: source.name,
      bytes: await readLevelDbSnapshotFile(job.databaseDirectory, source, signal),
    };
    signal?.throwIfAborted();
    records.push(
      ...readLevelDbRecords([file], {
        verifyChecksums: true,
        includeKey: (key) => keys.has(hex(key)),
      }),
    );
  }

  signal?.throwIfAborted();
  if (!useCache) {
    const world = createBedrockWorld(records);
    try {
      const tile = await world.renderTile(job.coordinates, renderOptions);
      signal?.throwIfAborted();
      return tile;
    } finally {
      await world.close();
    }
  }
  const tile = renderRecordTile(records, job.coordinates, renderOptions, {
    get: (chunkX, chunkZ, scoped) => pinned.get(surfaceKey(chunkX, chunkZ, scoped)),
    set: (chunkX, chunkZ, scoped, surface) => {
      cache!.setSurface(surfaceKey(chunkX, chunkZ, scoped), surface);
      if (stored !== undefined) store!.record(stored, chunkX, chunkZ, scoped, surface);
    },
  });
  signal?.throwIfAborted();
  return tile;
}

function unhex(encoded: string): Uint8Array {
  const bytes = new Uint8Array(encoded.length / 2);
  for (let index = 0; index < bytes.byteLength; index += 1) {
    bytes[index] = Number.parseInt(encoded.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function hex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += HEX_BYTES[byte];
  }
  return encoded;
}

const HEX_BYTES = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));
