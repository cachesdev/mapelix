import { DATA_2D_TAG, isMapRecordKey } from "./bedrock/chunk-key.js";
import { readLevelDbRecords } from "./bedrock/record-source.js";
import { readLevelDbSnapshotFile, type LevelDbSnapshotFile } from "./node-leveldb.js";
import type { ChunkSurface } from "./world.js";

/** Default per-renderer budget shared by the record and chunk-surface caches. */
export const DEFAULT_RENDER_CACHE_MIB = 256;

const MIB = 1024 * 1024;

export interface TileRenderCacheStats {
  surfaceHits: number;
  surfaceMisses: number;
  surfaceEvictions: number;
  fileParses: number;
  fileHits: number;
  fileEvictions: number;
}

/**
 * Bounded caches reused by consecutive tile renders of one opened world.
 *
 * Map records are kept per immutable database file name, so a file is read and inflated once
 * while it stays in the budget. Extracted chunk surfaces (top blocks, biome IDs and full-height
 * opacity runs) are kept per render configuration, so neighbouring tiles and other native zooms
 * reuse them instead of decoding the same subchunks again. Both caches evict least recently used
 * entries; their byte sizes are estimates of retained memory, not exact heap measurements.
 */
export class TileRenderCache {
  readonly stats: TileRenderCacheStats = {
    surfaceHits: 0,
    surfaceMisses: 0,
    surfaceEvictions: 0,
    fileParses: 0,
    fileHits: 0,
    fileEvictions: 0,
  };
  private readonly files: ByteLru<ReadonlyMap<string, Uint8Array>>;
  private readonly surfaces: ByteLru<ChunkSurface>;

  constructor(budgetMiB: number = DEFAULT_RENDER_CACHE_MIB) {
    if (!Number.isFinite(budgetMiB) || budgetMiB < 0) {
      throw new RangeError(`Render cache budget must be a non-negative number of MiB`);
    }
    const bytes = Math.floor(budgetMiB * MIB);
    const fileBytes = Math.floor(bytes / 4);
    this.files = new ByteLru(fileBytes, () => (this.stats.fileEvictions += 1));
    this.surfaces = new ByteLru(bytes - fileBytes, () => (this.stats.surfaceEvictions += 1));
  }

  get enabled(): boolean {
    return this.surfaces.budget > 0;
  }

  getSurface(key: string): ChunkSurface | undefined {
    const surface = this.surfaces.get(key);
    if (surface === undefined) this.stats.surfaceMisses += 1;
    else this.stats.surfaceHits += 1;
    return surface;
  }

  setSurface(key: string, surface: ChunkSurface): void {
    this.surfaces.set(key, surface, estimateSurfaceBytes(surface));
  }

  /**
   * Returns the live map records of one database file, keyed by hexadecimal key. Data2D records
   * are excluded because they travel with each render job. Files larger than the record budget
   * are read for the requested keys only and are not retained.
   */
  async fileRecords(
    databaseDirectory: string,
    file: LevelDbSnapshotFile,
    requestedKeys: ReadonlySet<string>,
    hexKey: (key: Uint8Array) => string,
    signal?: AbortSignal,
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const { name } = file;
    const cached = this.files.get(name);
    if (cached !== undefined) {
      this.stats.fileHits += 1;
      return cached;
    }
    const bytes = await readLevelDbSnapshotFile(databaseDirectory, file, signal);
    signal?.throwIfAborted();
    this.stats.fileParses += 1;
    const retain = bytes.byteLength <= this.files.budget;
    const records = new Map<string, Uint8Array>();
    let retainedBytes = 0;
    for (const record of readLevelDbRecords([{ name, bytes }], {
      verifyChecksums: true,
      includeKey: retain
        ? (key) => isMapRecordKey(key) && key[key.byteLength <= 10 ? 8 : 12] !== DATA_2D_TAG
        : (key) => requestedKeys.has(hexKey(key)),
    })) {
      const value = retain ? record.value.slice() : record.value;
      records.set(hexKey(record.key), value);
      retainedBytes += value.byteLength + record.key.byteLength * 2 + 96;
    }
    if (retain) this.files.set(name, records, retainedBytes);
    return records;
  }

  clear(): void {
    this.files.clear();
    this.surfaces.clear();
  }
}

function estimateSurfaceBytes(surface: ChunkSurface): number {
  let bytes = 64 + surface.length * 8;
  for (const sample of surface) {
    if (sample === undefined) continue;
    bytes += 160 + (sample.shadowRuns?.length ?? 0) * 48 + (sample.colorLayers?.length ?? 0) * 96;
  }
  return bytes;
}

class ByteLru<V> {
  readonly budget: number;
  private readonly entries = new Map<string, { readonly value: V; readonly bytes: number }>();
  private total = 0;
  private readonly onEvict: () => void;

  constructor(budget: number, onEvict: () => void) {
    this.budget = budget;
    this.onEvict = onEvict;
  }

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous !== undefined) {
      this.entries.delete(key);
      this.total -= previous.bytes;
    }
    if (bytes > this.budget) return;
    this.entries.set(key, { value, bytes });
    this.total += bytes;
    for (const [oldest, entry] of this.entries) {
      if (this.total <= this.budget) break;
      this.entries.delete(oldest);
      this.total -= entry.bytes;
      this.onEvict();
    }
  }

  clear(): void {
    this.entries.clear();
    this.total = 0;
  }
}
