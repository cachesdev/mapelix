import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { classifyChunkKey } from "./bedrock/chunk-key.js";
import {
  createLevelDbRecordIndex,
  readLevelDbRecords,
  type LevelDbRecordIndexEntry,
  type NamedLevelDbFile,
} from "./bedrock/record-source.js";
import type { RenderSurfaceOptions } from "./render.js";
import { floorDiv, type Dimension, type RenderedTile, type TileCoordinates } from "./tile.js";
import {
  createBedrockWorld,
  type BedrockWorld,
  type EffectiveBedrockRecord,
  type TileCoverage,
} from "./world.js";

export interface BedrockWorldDirectory {
  readonly directory: string;
}

interface IndexedTile {
  readonly sources: Map<string, Set<string>>;
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
  private renderQueue: Promise<void> = Promise.resolve();

  constructor(databaseDirectory: string, records: Iterable<LevelDbRecordIndexEntry>) {
    this.databaseDirectory = databaseDirectory;
    for (const record of records) {
      const key = classifyChunkKey(record.key);
      if (key === undefined) {
        continue;
      }
      const tileX = floorDiv(key.x, 16);
      const tileY = floorDiv(key.z, 16);
      const tileKey = indexTileKey(key.dimension, tileX, tileY);
      const tile = this.tiles.get(tileKey) ?? { sources: new Map(), subchunkCount: 0 };
      const keys = tile.sources.get(record.source) ?? new Set<string>();
      keys.add(hex(record.key));
      tile.sources.set(record.source, keys);
      tile.subchunkCount += 1;
      this.tiles.set(tileKey, tile);
    }
  }

  renderTile(
    coordinates: TileCoordinates,
    options: RenderSurfaceOptions = {},
  ): Promise<RenderedTile> {
    const pending = this.renderQueue.then(() => this.renderTileNow(coordinates, options));
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

  private async renderTileNow(
    coordinates: TileCoordinates,
    options: RenderSurfaceOptions,
  ): Promise<RenderedTile> {
    const dimension = DIMENSION_IDS[coordinates.dimension];
    const tile = this.tiles.get(indexTileKey(dimension, coordinates.x, coordinates.y));
    const records: EffectiveBedrockRecord[] = [];

    for (const [source, keys] of tile?.sources ?? []) {
      const file: NamedLevelDbFile = {
        name: source,
        bytes: await readFile(join(this.databaseDirectory, source)),
      };
      records.push(
        ...readLevelDbRecords([file], {
          includeKey: (key) => keys.has(hex(key)),
        }),
      );
    }

    return createBedrockWorld(records).renderTile(coordinates, options);
  }
}

/**
 * Opens an extracted Minecraft Bedrock world directory.
 *
 * Startup parses one database file at a time and retains only key metadata.
 * Tile values are loaded on demand, and tile renders are serialized to bound
 * the temporary memory used by concurrent HTTP requests.
 */
export async function openBedrockWorld(input: BedrockWorldDirectory): Promise<BedrockWorld> {
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
    includeKey: (key) => classifyChunkKey(key) !== undefined,
  });
  for (const entry of databaseFiles) {
    index.addFile({
      name: entry.name,
      bytes: await readFile(join(databaseDirectory, entry.name)),
    });
  }

  return new IndexedBedrockWorld(databaseDirectory, index.records());
}

function indexTileKey(dimension: number, x: number, y: number): string {
  return `${dimension}/${x}/${y}`;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
