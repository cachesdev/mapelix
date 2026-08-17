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
  type RenderTileOptions,
  type TileCoverage,
} from "./world.js";
import type { EffectiveBedrockRecord } from "./world.js";

export interface BedrockWorldDirectory {
  readonly directory: string;
  /** Maximum number of tiles rendered in parallel. One renders in the main process. */
  readonly renderConcurrency?: number;
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

const DIMENSION_IDS: Readonly<Record<Dimension, number>> = {
  overworld: 0,
  nether: 1,
  "the-end": 2,
};

class IndexedBedrockWorld implements BedrockWorld {
  readonly tiles = new Map<string, IndexedTile>();
  readonly databaseDirectory: string;
  private readonly workerPool: TileRenderWorkerPool | undefined;
  private renderQueue: Promise<void> = Promise.resolve();

  constructor(
    databaseDirectory: string,
    records: Iterable<LevelDbRecordIndexEntry>,
    renderConcurrency: number,
  ) {
    this.databaseDirectory = databaseDirectory;
    this.workerPool =
      renderConcurrency > 1 ? new TileRenderWorkerPool(renderConcurrency) : undefined;
    const buildingTiles = new Map<string, BuildingTile>();
    for (const record of records) {
      const location = classifyMapRecordKey(record.key);
      if (location === undefined) {
        continue;
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
    const job = this.createRenderJob(coordinates, options);
    if (this.workerPool !== undefined && Object.keys(options).length === 0) {
      return this.workerPool.render(job);
    }

    const pending = this.renderQueue.then(() => renderIndexedTile(job, options));
    this.renderQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  getTileCoverage(dimension: Dimension): readonly TileCoverage[] {
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
    };
  }
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
  });
  for (const entry of databaseFiles) {
    index.addFile({
      name: entry.name,
      bytes: await readFile(join(databaseDirectory, entry.name)),
    });
  }

  return new IndexedBedrockWorld(databaseDirectory, index.drainRecords(), renderConcurrency);
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
