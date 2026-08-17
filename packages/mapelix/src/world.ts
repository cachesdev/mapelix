import {
  DATA_2D_TAG,
  SUBCHUNK_TAG,
  classifyChunkKey,
  classifyMapRecordKey,
} from "./bedrock/chunk-key.js";
import { data2DBiomeAt, decodeData2D, type DecodedData2D } from "./bedrock/data-2d.js";
import type { LevelDbRecord } from "./bedrock/record-source.js";
import { decodeSubchunk, type DecodedSubchunk } from "./bedrock/subchunk.js";
import { encodePng } from "./png.js";
import { renderSurface, type RenderSurfaceOptions } from "./render.js";
import {
  TILE_SIZE,
  floorDiv,
  tileBlockSpan,
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
      const location = classifyMapRecordKey(record.key);
      if (location === undefined) {
        continue;
      }
      const tileX = floorDiv(location.x, 16);
      const tileY = floorDiv(location.z, 16);
      const tileKey = tileRecordKey(location.dimension, tileX, tileY);
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
    const biomeChunks = new Map<number, Map<number, DecodedData2D>>();
    const storageTileX = floorDiv(bounds.minX, TILE_SIZE);
    const storageTileY = floorDiv(bounds.minZ, TILE_SIZE);
    const records = this.tileRecords.get(tileRecordKey(dimension, storageTileX, storageTileY));

    for (let tileOffsetY = -1; tileOffsetY <= 1; tileOffsetY += 1) {
      for (let tileOffsetX = -1; tileOffsetX <= 1; tileOffsetX += 1) {
        const neighborRecords = this.tileRecords.get(
          tileRecordKey(dimension, storageTileX + tileOffsetX, storageTileY + tileOffsetY),
        );
        for (const record of neighborRecords ?? []) {
          const mapKey = classifyMapRecordKey(record.key);
          if (mapKey?.tag !== DATA_2D_TAG || mapKey.dimension !== dimension) continue;
          const data = decodeData2D(record.key, record.value);
          if (data !== undefined) setBiomeChunk(biomeChunks, mapKey.x, mapKey.z, data);
        }
      }
    }

    for (const record of records ?? []) {
      const mapKey = classifyMapRecordKey(record.key);
      if (mapKey?.tag === DATA_2D_TAG) {
        continue;
      }
      const key = mapKey?.tag === SUBCHUNK_TAG ? mapKey : undefined;
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

    const blockSpan = tileBlockSpan(coordinates.z);
    const samples = Array.from(
      { length: blockSpan * blockSpan },
      (): SurfaceBlock | undefined => undefined,
    );
    for (const subchunks of chunks.values()) {
      subchunks.sort((left, right) => right.y - left.y);
      const key = subchunks[0]?.key;
      if (key === undefined) {
        continue;
      }
      writeChunkSurface(
        samples,
        blockSpan,
        bounds.minX,
        bounds.minZ,
        key.x,
        key.z,
        subchunks,
        biomeChunks.get(key.x)?.get(key.z),
      );
    }

    const rgba = renderSurface(samples, options, {
      biomeAt: (x, z) => biomeAt(biomeChunks, bounds.minX + x, bounds.minZ + z),
    });
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
        subchunkCount: records.reduce(
          (count, record) => count + (classifyChunkKey(record.key) === undefined ? 0 : 1),
          0,
        ),
      });
    }
    return coverage;
  }
}

function biomeAt(
  biomeChunks: ReadonlyMap<number, ReadonlyMap<number, DecodedData2D>>,
  worldX: number,
  worldZ: number,
): number | undefined {
  const chunkX = floorDiv(worldX, 16);
  const chunkZ = floorDiv(worldZ, 16);
  const biomes = biomeChunks.get(chunkX)?.get(chunkZ);
  if (biomes === undefined) return undefined;
  return data2DBiomeAt(biomes, worldX - chunkX * 16, worldZ - chunkZ * 16);
}

function setBiomeChunk(
  biomeChunks: Map<number, Map<number, DecodedData2D>>,
  chunkX: number,
  chunkZ: number,
  data: DecodedData2D,
): void {
  const zChunks = biomeChunks.get(chunkX) ?? new Map<number, DecodedData2D>();
  zChunks.set(chunkZ, data);
  biomeChunks.set(chunkX, zChunks);
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
  sampleSize: number,
  tileMinX: number,
  tileMinZ: number,
  chunkX: number,
  chunkZ: number,
  subchunks: readonly DecodedSubchunk[],
  biomes: DecodedData2D | undefined,
): void {
  for (let localZ = 0; localZ < 16; localZ += 1) {
    for (let localX = 0; localX < 16; localX += 1) {
      const surface = findSurfaceBlock(subchunks, localX, localZ);
      if (surface === undefined) {
        continue;
      }
      const pixelX = chunkX * 16 + localX - tileMinX;
      const pixelZ = chunkZ * 16 + localZ - tileMinZ;
      if (pixelX < 0 || pixelX >= sampleSize || pixelZ < 0 || pixelZ >= sampleSize) continue;
      const biomeId = biomes === undefined ? undefined : data2DBiomeAt(biomes, localX, localZ);
      samples[pixelZ * sampleSize + pixelX] =
        biomeId === undefined ? surface : { ...surface, biomeId };
    }
  }
}

function findSurfaceBlock(
  subchunks: readonly DecodedSubchunk[],
  localX: number,
  localZ: number,
): SurfaceBlock | undefined {
  let decorativeCover: SurfaceBlock | undefined;
  let waterSurface: SurfaceBlock | undefined;
  let fluidDepth = 0;
  for (const subchunk of subchunks) {
    for (let localY = 15; localY >= 0; localY -= 1) {
      const blockIndex = localX * 256 + localZ * 16 + localY;
      const paletteIndex = subchunk.primary.indexes[blockIndex];
      const name = paletteIndex === undefined ? undefined : subchunk.primary.palette[paletteIndex];
      if (name !== undefined && !isAir(name)) {
        const y = subchunk.y * 16 + localY;
        if (decorativeCover !== undefined) {
          if (isDecorativeCover(name)) continue;
          return { ...decorativeCover, supportY: y };
        }
        if (isDecorativeCover(name)) {
          decorativeCover = { name, y };
          continue;
        }
        if (waterSurface === undefined) {
          if (!isWater(name)) {
            return { name, y };
          }
          waterSurface = { name, y };
          fluidDepth = 1;
        } else if (isWater(name)) {
          fluidDepth += 1;
        } else {
          return { ...waterSurface, fluidDepth, underwaterName: name };
        }
      }
    }
  }
  if (decorativeCover !== undefined) return decorativeCover;
  return waterSurface === undefined ? undefined : { ...waterSurface, fluidDepth };
}

function isDecorativeCover(name: string): boolean {
  const separator = name.indexOf(":");
  const block = separator === -1 ? name : name.slice(separator + 1);
  return (
    block === "short_grass" ||
    block === "tall_grass" ||
    block === "tallgrass" ||
    block === "fern" ||
    block === "large_fern" ||
    block === "deadbush" ||
    block.endsWith("_sapling") ||
    block.endsWith("_flower") ||
    /^(?:dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|sunflower|lilac|rose_bush|peony|torchflower|pitcher_plant)$/.test(
      block,
    )
  );
}

function isAir(name: string): boolean {
  return (
    name === "minecraft:air" ||
    name === "minecraft:cave_air" ||
    name === "minecraft:void_air" ||
    name === "minecraft:structure_void"
  );
}

function isWater(name: string): boolean {
  return name === "minecraft:water" || name === "minecraft:flowing_water";
}

function tileRecordKey(dimension: number, tileX: number, tileY: number): string {
  return `${dimension}/${tileX}/${tileY}`;
}
