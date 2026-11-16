import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DATA_2D_TAG,
  SUBCHUNK_TAG,
  classifyMapRecordKey,
  isMapRecordKey,
} from "./bedrock/chunk-key.js";
import { createLevelDbRecordIndex, type LevelDbRecordIndexEntry } from "./bedrock/record-source.js";
import {
  renderIndexedTile,
  type IndexedTileRenderJob,
  type IndexedTileSource,
  type PackedKeyGroup,
} from "./node-tile-render.js";
import { TileRenderWorkerPool } from "./node-worker-pool.js";
import { DEFAULT_RENDER_CACHE_MIB, TileRenderCache } from "./tile-render-cache.js";
import type { SurfaceStyle } from "./surface-style.js";
import { renderAbortError } from "./render-abort.js";
import { assertSurfaceRange } from "./surface-range.js";
import {
  TILE_SIZE,
  floorDiv,
  tileBounds,
  type BlockBounds,
  type Dimension,
  type RenderedTile,
  type TileCoordinates,
} from "./tile.js";
import {
  tileInputBounds,
  type BedrockWorld,
  type CloseWorldOptions,
  type RenderTileOptions,
  type TileCoverage,
} from "./world.js";
import type { EffectiveBedrockRecord } from "./world.js";

export interface BedrockWorldDirectory {
  readonly directory: string;
  /** Maximum number of tiles rendered in parallel. One renders in the main process. */
  readonly renderConcurrency?: number;
  /** Use an abortable worker even at concurrency one; callbacks are then unsupported. */
  readonly forceWorkers?: boolean;
  /**
   * Memory budget, in MiB, for the record and chunk-surface caches of each renderer (every worker
   * has its own). Zero disables reuse between tiles. Defaults to 256.
   */
  readonly renderCacheMiB?: number;
  /** Digest every map record at startup so `getChunkFingerprints` can detect changed chunks. */
  readonly chunkFingerprints?: boolean;
  /** Cancels startup reads; close({ abort: true }) cancels an opened world. */
  readonly signal?: AbortSignal;
}

interface ChunkDigest {
  readonly xor: Uint8Array;
  count: number;
}

interface IndexedTile {
  readonly sources: readonly IndexedTileSource[];
  readonly biomeRecords: readonly EffectiveBedrockRecord[];
  subchunkCount: number;
}

interface BuildingTile {
  readonly sources: Map<string, Map<number, PackedKeyBuilder>>;
  readonly biomeRecords: EffectiveBedrockRecord[];
  subchunkCount: number;
}

let nextStyleId = 1;

const DIMENSION_IDS: Readonly<Record<Dimension, number>> = {
  overworld: 0,
  nether: 1,
  "the-end": 2,
};

class IndexedBedrockWorld implements BedrockWorld {
  readonly tiles = new Map<string, IndexedTile>();
  readonly databaseDirectory: string;
  private readonly workerPool: TileRenderWorkerPool | undefined;
  private readonly forceWorkers: boolean;
  private renderQueue: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | undefined;
  private readonly renderAbort = new AbortController();
  private readonly renderCache: TileRenderCache;
  private readonly styleIds = new WeakMap<SurfaceStyle, number>();
  private readonly fingerprints: Map<number, Map<string, ChunkDigest>> | undefined;

  constructor(
    databaseDirectory: string,
    records: Iterable<LevelDbRecordIndexEntry>,
    renderConcurrency: number,
    forceWorkers: boolean,
    renderCacheMiB: number,
    fingerprints: boolean,
  ) {
    this.databaseDirectory = databaseDirectory;
    this.forceWorkers = forceWorkers;
    this.workerPool =
      renderConcurrency > 1 || forceWorkers
        ? new TileRenderWorkerPool(renderConcurrency, renderCacheMiB)
        : undefined;
    this.renderCache = new TileRenderCache(this.workerPool === undefined ? renderCacheMiB : 0);
    const buildingTiles = new Map<string, BuildingTile>();
    this.fingerprints = fingerprints ? new Map() : undefined;
    for (const record of records) {
      const location = classifyMapRecordKey(record.key);
      if (location === undefined) {
        continue;
      }
      if (this.fingerprints !== undefined) {
        const chunks = this.fingerprints.get(location.dimension) ?? new Map<string, ChunkDigest>();
        this.fingerprints.set(location.dimension, chunks);
        const chunkKey = `${location.x},${location.z}`;
        const chunk = chunks.get(chunkKey) ?? { xor: new Uint8Array(16), count: 0 };
        chunks.set(chunkKey, chunk);
        // Keys are unique within a chunk, so an XOR of keyed record digests is order-independent.
        const recordDigest = createHash("sha256")
          .update(record.key)
          .update(record.digest ?? new Uint8Array())
          .digest();
        for (let index = 0; index < 16; index += 1) chunk.xor[index]! ^= recordDigest[index]!;
        chunk.count += 1;
      }
      const tileX = floorDiv(location.x, 16);
      const tileY = floorDiv(location.z, 16);
      const tileKey = indexTileKey(location.dimension, tileX, tileY);
      const tile = buildingTiles.get(tileKey) ?? {
        sources: new Map(),
        biomeRecords: [] as EffectiveBedrockRecord[],
        subchunkCount: 0,
      };
      if (location.tag === DATA_2D_TAG) {
        if (record.value !== undefined)
          tile.biomeRecords.push({ key: record.key, value: record.value });
        buildingTiles.set(tileKey, tile);
        continue;
      }
      const source = tile.sources.get(record.source) ?? new Map<number, PackedKeyBuilder>();
      const keys = source.get(record.key.byteLength) ?? new PackedKeyBuilder(record.key.byteLength);
      keys.add(record.key);
      source.set(record.key.byteLength, keys);
      tile.sources.set(record.source, source);
      if (location.tag === SUBCHUNK_TAG) {
        tile.subchunkCount += 1;
      }
      buildingTiles.set(tileKey, tile);
    }

    for (const [tileKey, tile] of buildingTiles) {
      this.tiles.set(tileKey, {
        sources: [...tile.sources].map(([name, groups]) => ({
          name,
          keyGroups: [...groups.values()].map((group) => group.finish()),
        })),
        biomeRecords: tile.biomeRecords,
        subchunkCount: tile.subchunkCount,
      });
    }
  }

  renderTile(coordinates: TileCoordinates, options: RenderTileOptions = {}): Promise<RenderedTile> {
    if (this.closePromise !== undefined)
      return Promise.reject(new Error("The Bedrock world is closed"));
    assertSurfaceRange(options.surfaceRange);
    const job = this.createRenderJob(coordinates, options);
    if (this.forceWorkers && options.resolveBlockStyle !== undefined) {
      return Promise.reject(
        new TypeError("Worker rendering does not support resolveBlockStyle callbacks"),
      );
    }
    if (this.workerPool !== undefined && options.resolveBlockStyle === undefined) {
      return this.workerPool.render(job);
    }

    const pending = this.renderQueue.then(() =>
      renderIndexedTile(job, options, this.renderAbort.signal, this.renderCache),
    );
    this.renderQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  getChunkFingerprints(dimension: Dimension): ReadonlyMap<string, string> {
    if (this.closePromise !== undefined) throw new Error("The Bedrock world is closed");
    if (this.fingerprints === undefined)
      throw new Error("Open the world with chunkFingerprints: true to read chunk fingerprints");
    const result = new Map<string, string>();
    for (const [chunkKey, chunk] of this.fingerprints.get(DIMENSION_IDS[dimension]) ?? []) {
      result.set(chunkKey, `${Buffer.from(chunk.xor).toString("hex")}${chunk.count.toString(16)}`);
    }
    return result;
  }

  getTileCoverage(dimension: Dimension): readonly TileCoverage[] {
    if (this.closePromise !== undefined) throw new Error("The Bedrock world is closed");
    const prefix = `${DIMENSION_IDS[dimension]}/`;
    const coverage: TileCoverage[] = [];
    for (const [key, tile] of this.tiles) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const [, tileX, tileY] = key.split("/");
      coverage.push({
        x: Number(tileX),
        y: Number(tileY),
        subchunkCount: tile.subchunkCount,
      });
    }
    return coverage;
  }

  close(options: CloseWorldOptions = {}): Promise<void> {
    if (options.abort === true) this.renderAbort.abort(renderAbortError());
    const workersClosed = this.workerPool?.close(options);
    this.closePromise ??= this.drainAndClose(workersClosed);
    return this.closePromise;
  }

  private async drainAndClose(workersClosed: Promise<void> | undefined): Promise<void> {
    try {
      await Promise.all([this.renderQueue, workersClosed]);
    } finally {
      this.tiles.clear();
      this.renderCache.clear();
    }
  }

  private cacheKey(dimension: number, options: RenderTileOptions): string {
    const style = options.surfaceStyle;
    let styleId = 0;
    if (style !== undefined) {
      styleId = this.styleIds.get(style) ?? 0;
      if (styleId === 0) {
        styleId = nextStyleId++;
        this.styleIds.set(style, styleId);
      }
    }
    return surfaceCacheKey(dimension, options, styleId);
  }

  private createRenderJob(
    coordinates: TileCoordinates,
    options: RenderTileOptions,
  ): IndexedTileRenderJob {
    const dimension = DIMENSION_IDS[coordinates.dimension];
    const bounds = tileBounds(coordinates);
    const inputBounds = tileInputBounds(coordinates, options.shadows !== false);
    const storageTileX = floorDiv(bounds.minX, TILE_SIZE);
    const storageTileY = floorDiv(bounds.minZ, TILE_SIZE);
    const biomeRecords: EffectiveBedrockRecord[] = [];
    const sourceGroups = new Map<string, PackedKeyGroup[]>();

    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        const neighbor = this.tiles.get(
          indexTileKey(dimension, storageTileX + offsetX, storageTileY + offsetY),
        );
        biomeRecords.push(...(neighbor?.biomeRecords ?? []));
      }
    }

    const minInputTileX = floorDiv(inputBounds.minX, TILE_SIZE);
    const minInputTileY = floorDiv(inputBounds.minZ, TILE_SIZE);
    const maxInputTileX = floorDiv(inputBounds.maxX - 1, TILE_SIZE);
    const maxInputTileY = floorDiv(inputBounds.maxZ - 1, TILE_SIZE);
    for (let inputTileY = minInputTileY; inputTileY <= maxInputTileY; inputTileY += 1) {
      for (let inputTileX = minInputTileX; inputTileX <= maxInputTileX; inputTileX += 1) {
        const inputTile = this.tiles.get(indexTileKey(dimension, inputTileX, inputTileY));
        for (const source of filterSources(inputTile?.sources ?? [], inputBounds)) {
          const groups = sourceGroups.get(source.name) ?? [];
          groups.push(...source.keyGroups);
          sourceGroups.set(source.name, groups);
        }
      }
    }

    return {
      coordinates,
      databaseDirectory: this.databaseDirectory,
      sources: [...sourceGroups].map(([name, keyGroups]) => ({ name, keyGroups })),
      biomeRecords,
      cacheKey: this.cacheKey(dimension, options),
      ...(options.surfaceRange === undefined ? {} : { surfaceRange: options.surfaceRange }),
      ...(options.surfaceStyle === undefined ? {} : { surfaceStyle: options.surfaceStyle }),
      options: {
        ...(options.shadows === undefined ? {} : { shadows: options.shadows }),
        ...(options.biomeBlendRadius === undefined
          ? {}
          : { biomeBlendRadius: options.biomeBlendRadius }),
        ...(options.correctReferenceBugs === undefined
          ? {}
          : { correctReferenceBugs: options.correctReferenceBugs }),
        ...(options.includeSurface === undefined ? {} : { includeSurface: options.includeSurface }),
      },
    };
  }
}

/** Jobs with equal keys extract identical chunk surfaces from identical records. */
function surfaceCacheKey(dimension: number, options: RenderTileOptions, styleId: number): string {
  const range = options.surfaceRange;
  return [
    dimension,
    range === undefined ? "full" : `${range.minY}:${range.maxY}:${range.topY}`,
    styleId,
  ].join("/");
}

function filterSources(
  sources: readonly IndexedTileSource[],
  bounds: BlockBounds,
): IndexedTileSource[] {
  const minChunkX = floorDiv(bounds.minX, 16);
  const minChunkZ = floorDiv(bounds.minZ, 16);
  const maxChunkX = floorDiv(bounds.maxX - 1, 16);
  const maxChunkZ = floorDiv(bounds.maxZ - 1, 16);
  const filtered: IndexedTileSource[] = [];

  for (const source of sources) {
    const keyGroups = source.keyGroups
      .map((group) => filterKeyGroup(group, minChunkX, minChunkZ, maxChunkX, maxChunkZ))
      .filter((group) => group.bytes.byteLength > 0);
    if (keyGroups.length > 0) filtered.push({ name: source.name, keyGroups });
  }
  return filtered;
}

function filterKeyGroup(
  group: PackedKeyGroup,
  minChunkX: number,
  minChunkZ: number,
  maxChunkX: number,
  maxChunkZ: number,
): PackedKeyGroup {
  const selected = new Uint8Array(group.bytes.byteLength);
  const view = new DataView(group.bytes.buffer, group.bytes.byteOffset, group.bytes.byteLength);
  let outputOffset = 0;
  for (let offset = 0; offset < group.bytes.byteLength; offset += group.keyLength) {
    const chunkX = view.getInt32(offset, true);
    const chunkZ = view.getInt32(offset + 4, true);
    if (chunkX >= minChunkX && chunkX <= maxChunkX && chunkZ >= minChunkZ && chunkZ <= maxChunkZ) {
      selected.set(group.bytes.subarray(offset, offset + group.keyLength), outputOffset);
      outputOffset += group.keyLength;
    }
  }
  return outputOffset === group.bytes.byteLength
    ? group
    : { bytes: selected.slice(0, outputOffset), keyLength: group.keyLength };
}

/**
 * Opens an extracted Minecraft Bedrock world directory.
 *
 * Startup parses one database file at a time and retains only key metadata.
 * Tile values are loaded on demand, and tile renders are serialized to bound
 * the temporary memory used by concurrent HTTP requests.
 */
export async function openBedrockWorld(input: BedrockWorldDirectory): Promise<BedrockWorld> {
  input.signal?.throwIfAborted();
  const renderConcurrency = input.renderConcurrency ?? 1;
  if (!Number.isSafeInteger(renderConcurrency) || renderConcurrency < 1) {
    throw new RangeError(
      `renderConcurrency must be a positive integer, received ${renderConcurrency}`,
    );
  }
  const databaseDirectory = join(input.directory, "db");
  const entries = await readdir(databaseDirectory, { withFileTypes: true });
  const databaseFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ldb") || entry.name.endsWith(".sst") || entry.name.endsWith(".log")),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  const index = createLevelDbRecordIndex({
    includeKey: isMapRecordKey,
    retainValue: (key, value) => {
      const tagOffset = key.byteLength === 9 ? 8 : 12;
      return (key.byteLength === 9 || key.byteLength === 13) && key[tagOffset] === DATA_2D_TAG
        ? value.subarray(512)
        : undefined;
    },
    ...(input.chunkFingerprints === true
      ? {
          digestValue: (_key: Uint8Array, value: Uint8Array) =>
            createHash("sha256").update(value).digest().subarray(0, 16),
        }
      : {}),
  });
  for (const entry of databaseFiles) {
    input.signal?.throwIfAborted();
    index.addFile({
      name: entry.name,
      bytes: await readFile(join(databaseDirectory, entry.name), { signal: input.signal }),
    });
  }

  input.signal?.throwIfAborted();
  return new IndexedBedrockWorld(
    databaseDirectory,
    index.drainRecords(),
    renderConcurrency,
    input.forceWorkers === true,
    input.renderCacheMiB ?? DEFAULT_RENDER_CACHE_MIB,
    input.chunkFingerprints === true,
  );
}

function indexTileKey(dimension: number, x: number, y: number): string {
  return `${dimension}/${x}/${y}`;
}

class PackedKeyBuilder {
  readonly keyLength: number;
  private bytes: Uint8Array;
  private count = 0;

  constructor(keyLength: number) {
    this.keyLength = keyLength;
    this.bytes = new Uint8Array(keyLength * 4);
  }

  add(key: Uint8Array): void {
    const requiredLength = (this.count + 1) * this.keyLength;
    if (requiredLength > this.bytes.byteLength) {
      const expanded = new Uint8Array(Math.max(requiredLength, this.bytes.byteLength * 2));
      expanded.set(this.bytes);
      this.bytes = expanded;
    }
    this.bytes.set(key, this.count * this.keyLength);
    this.count += 1;
  }

  finish(): PackedKeyGroup {
    return {
      bytes: this.bytes.slice(0, this.count * this.keyLength),
      keyLength: this.keyLength,
    };
  }
}
