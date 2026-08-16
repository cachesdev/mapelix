import { classifyChunkKey } from "./bedrock/chunk-key.js";
import type { LevelDbRecord } from "./bedrock/record-source.js";
import { decodeSubchunk, type DecodedSubchunk } from "./bedrock/subchunk.js";
import { encodePng } from "./png.js";
import { renderSurface, type RenderSurfaceOptions } from "./render.js";
import {
  TILE_SIZE,
  floorDiv,
  tileBounds,
  type Dimension,
  type RenderedTile,
  type SurfaceBlock,
  type TileCoordinates,
} from "./tile.js";

export type EffectiveBedrockRecord = Pick<LevelDbRecord, "key" | "value">;

export interface BedrockWorld {
  renderTile(coordinates: TileCoordinates, options?: RenderSurfaceOptions): Promise<RenderedTile>;
  getTileCoverage(dimension: Dimension): readonly TileCoverage[];
}

export interface TileCoverage {
  readonly x: number;
  readonly y: number;
  readonly subchunkCount: number;
}

const DIMENSION_IDS: Readonly<Record<Dimension, number>> = {
  overworld: 0,
  nether: 1,
  "the-end": 2,
};

class RecordBedrockWorld implements BedrockWorld {
  readonly tileRecords = new Map<string, EffectiveBedrockRecord[]>();

  constructor(records: Iterable<EffectiveBedrockRecord>) {
    for (const record of records) {
      const key = classifyChunkKey(record.key);
      if (key === undefined) {
        continue;
      }
      const tileX = floorDiv(key.x, 16);
      const tileY = floorDiv(key.z, 16);
      const tileKey = tileRecordKey(key.dimension, tileX, tileY);
      const group = this.tileRecords.get(tileKey) ?? [];
      group.push(record);
      this.tileRecords.set(tileKey, group);
    }
  }

  async renderTile(
    coordinates: TileCoordinates,
    options: RenderSurfaceOptions = {},
  ): Promise<RenderedTile> {
    const bounds = tileBounds(coordinates);
    const dimension = DIMENSION_IDS[coordinates.dimension];
    const chunks = new Map<string, DecodedSubchunk[]>();
    const records = this.tileRecords.get(tileRecordKey(dimension, coordinates.x, coordinates.y));

    for (const record of records ?? []) {
      const key = classifyChunkKey(record.key);
      if (
        key === undefined ||
        key.dimension !== dimension ||
        key.x * 16 < bounds.minX ||
        key.x * 16 >= bounds.maxX ||
        key.z * 16 < bounds.minZ ||
        key.z * 16 >= bounds.maxZ
      ) {
        continue;
      }

      const subchunk = decodeSubchunk(record.key, record.value);
      if (subchunk === undefined) {
        continue;
      }
      const chunkKey = `${key.x},${key.z}`;
      const group = chunks.get(chunkKey) ?? [];
      group.push(subchunk);
      chunks.set(chunkKey, group);
    }

    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    for (const subchunks of chunks.values()) {
      subchunks.sort((left, right) => right.y - left.y);
      const key = subchunks[0]?.key;
      if (key === undefined) {
        continue;
      }
      writeChunkSurface(samples, bounds.minX, bounds.minZ, key.x, key.z, subchunks);
    }

    const rgba = renderSurface(samples, options);
    return {
      coordinates,
      bounds,
      width: TILE_SIZE,
      height: TILE_SIZE,
      rgba,
      png: encodePng(rgba, TILE_SIZE, TILE_SIZE),
    };
  }

  getTileCoverage(dimension: Dimension): readonly TileCoverage[] {
    const dimensionId = DIMENSION_IDS[dimension];
    const prefix = `${dimensionId}/`;
    const coverage: TileCoverage[] = [];
    for (const [key, records] of this.tileRecords) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      const [, tileX, tileY] = key.split("/");
      coverage.push({
        x: Number(tileX),
        y: Number(tileY),
        subchunkCount: records.length,
      });
    }
    return coverage;
  }
}

/**
 * Creates a renderer from effective Bedrock key/value records.
 *
 * This is the integration seam for a future live source such as Canopy. The
 * records must already have LevelDB tombstones and sequence ordering applied.
 */
export function createBedrockWorld(records: Iterable<EffectiveBedrockRecord>): BedrockWorld {
  return new RecordBedrockWorld(records);
}

function writeChunkSurface(
  samples: Array<SurfaceBlock | undefined>,
  tileMinX: number,
  tileMinZ: number,
  chunkX: number,
  chunkZ: number,
  subchunks: readonly DecodedSubchunk[],
): void {
  for (let localZ = 0; localZ < 16; localZ += 1) {
    for (let localX = 0; localX < 16; localX += 1) {
      const surface = findSurfaceBlock(subchunks, localX, localZ);
      if (surface === undefined) {
        continue;
      }
      const pixelX = chunkX * 16 + localX - tileMinX;
      const pixelZ = chunkZ * 16 + localZ - tileMinZ;
      samples[pixelZ * TILE_SIZE + pixelX] = surface;
    }
  }
}

function findSurfaceBlock(
  subchunks: readonly DecodedSubchunk[],
  localX: number,
  localZ: number,
): SurfaceBlock | undefined {
  for (const subchunk of subchunks) {
    for (let localY = 15; localY >= 0; localY -= 1) {
      const blockIndex = localX * 256 + localZ * 16 + localY;
      const paletteIndex = subchunk.primary.indexes[blockIndex];
      const name = paletteIndex === undefined ? undefined : subchunk.primary.palette[paletteIndex];
      if (name !== undefined && !isAir(name)) {
        return { name, y: subchunk.y * 16 + localY };
      }
    }
  }
  return undefined;
}

function isAir(name: string): boolean {
  return (
    name === "minecraft:air" ||
    name === "minecraft:cave_air" ||
    name === "minecraft:void_air" ||
    name === "minecraft:structure_void"
  );
}

function tileRecordKey(dimension: number, tileX: number, tileY: number): string {
  return `${dimension}/${tileX}/${tileY}`;
}
