import {
  DATA_2D_TAG,
  DATA_3D_TAG,
  SUBCHUNK_TAG,
  classifyChunkKey,
  classifyMapRecordKey,
} from "./bedrock/chunk-key.js";
import { data2DBiomeAt, decodeData2D, type DecodedData2D } from "./bedrock/data-2d.js";
import { data3DBiomeAt, decodeData3D, type DecodedData3D } from "./bedrock/data-3d.js";
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
  type ShadowOpacityRun,
  type SurfaceBlock,
  type SurfaceColorLayer,
  type TileCoordinates,
} from "./tile.js";

export type EffectiveBedrockRecord = Pick<LevelDbRecord, "key" | "value">;

export interface BedrockWorld {
  renderTile(coordinates: TileCoordinates, options?: RenderTileOptions): Promise<RenderedTile>;
  getTileCoverage(dimension: Dimension): readonly TileCoverage[];
}

export interface RenderTileOptions extends RenderSurfaceOptions {
  /** Include block name, Y, biome, and shadow-run surface samples in the returned tile. */
  readonly includeSurface?: boolean;
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
    options: RenderTileOptions = {},
  ): Promise<RenderedTile> {
    const bounds = tileBounds(coordinates);
    const dimension = DIMENSION_IDS[coordinates.dimension];
    const chunks = new Map<string, DecodedSubchunk[]>();
    const biomeChunks = new Map<number, Map<number, DecodedData2D>>();
    const biome3DChunks = new Map<number, Map<number, DecodedData3D>>();
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
          if (mapKey === undefined || mapKey.dimension !== dimension) continue;
          if (mapKey.tag === DATA_2D_TAG) {
            const data = decodeData2D(record.key, record.value);
            if (data !== undefined) setBiomeChunk(biomeChunks, mapKey.x, mapKey.z, data);
          } else if (mapKey.tag === DATA_3D_TAG) {
            const data = decodeData3D(record.key, record.value);
            if (data !== undefined) setBiomeChunk(biome3DChunks, mapKey.x, mapKey.z, data);
          }
        }
      }
    }

    for (const record of records ?? []) {
      const mapKey = classifyMapRecordKey(record.key);
      if (mapKey?.tag === DATA_2D_TAG || mapKey?.tag === DATA_3D_TAG) {
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
        biome3DChunks.get(key.x)?.get(key.z),
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
      ...(options.includeSurface === true ? { surface: { sampleSize: blockSpan, samples } } : {}),
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

function setBiomeChunk<T>(
  biomeChunks: Map<number, Map<number, T>>,
  chunkX: number,
  chunkZ: number,
  data: T,
): void {
  const zChunks = biomeChunks.get(chunkX) ?? new Map<number, T>();
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
  biomes3D: DecodedData3D | undefined,
): void {
  const biomeSectionYs = subchunks
    .map((subchunk) => subchunk.y)
    .filter((y) => y >= -4 && y <= 19)
    .sort((left, right) => left - right);
  for (let localZ = 0; localZ < 16; localZ += 1) {
    for (let localX = 0; localX < 16; localX += 1) {
      const surface = findSurfaceBlock(subchunks, localX, localZ);
      if (surface === undefined) {
        continue;
      }
      const pixelX = chunkX * 16 + localX - tileMinX;
      const pixelZ = chunkZ * 16 + localZ - tileMinZ;
      if (pixelX < 0 || pixelX >= sampleSize || pixelZ < 0 || pixelZ >= sampleSize) continue;
      const biomeId =
        (biomes3D === undefined
          ? undefined
          : data3DBiomeAt(biomes3D, biomeSectionYs, localX, surface.y, localZ)) ??
        (biomes === undefined ? undefined : data2DBiomeAt(biomes, localX, localZ));
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
  let surface: SurfaceBlock | undefined;
  let fluidDepth = 0;
  const colorLayers: SurfaceColorLayer[] = [];
  let translucentTopY: number | undefined;
  const shadowRuns: ShadowOpacityRun[] = [];
  for (const subchunk of subchunks) {
    for (let localY = 15; localY >= 0; localY -= 1) {
      const blockIndex = localX * 256 + localZ * 16 + localY;
      const paletteIndex = subchunk.primary.indexes[blockIndex];
      const name = paletteIndex === undefined ? undefined : subchunk.primary.palette[paletteIndex];
      if (name !== undefined && !isAir(name)) {
        const y = subchunk.y * 16 + localY;
        addShadowVoxel(shadowRuns, y, blockShadowOpacity(name));
        if (surface !== undefined) continue;
        if (
          decorativeCover === undefined &&
          waterSurface === undefined &&
          isTranslucentGlass(name)
        ) {
          translucentTopY ??= y;
          addColorLayer(colorLayers, name);
          continue;
        }
        if (waterSurface !== undefined) {
          if (isWater(name)) {
            fluidDepth += 1;
          } else {
            surface = { ...waterSurface, fluidDepth, underwaterName: name };
          }
          continue;
        }
        if (decorativeCover !== undefined) {
          if (isDecorativeCover(name)) continue;
          surface = { ...decorativeCover, supportY: y };
          continue;
        }
        if (isDecorativeCover(name)) {
          decorativeCover = { name, y };
          continue;
        }
        if (!isWater(name)) {
          surface = { name, y };
          continue;
        }
        waterSurface = { name, y };
        fluidDepth = 1;
      }
    }
  }
  surface ??=
    decorativeCover ?? (waterSurface === undefined ? undefined : { ...waterSurface, fluidDepth });
  if (colorLayers.length > 0) {
    if (surface !== undefined) {
      colorLayers.push({
        name: surface.name,
        count: 1,
        ...(surface.fluidDepth === undefined ? {} : { fluidDepth: surface.fluidDepth }),
        ...(surface.underwaterName === undefined ? {} : { underwaterName: surface.underwaterName }),
      });
    }
    const top = colorLayers[0]!;
    surface = {
      name: top.name,
      y: translucentTopY!,
      colorLayers,
    };
  }
  return surface === undefined ? undefined : { ...surface, shadowRuns };
}

function addColorLayer(layers: SurfaceColorLayer[], name: string): void {
  const previous = layers.at(-1);
  if (previous?.name === name && previous.fluidDepth === undefined) {
    layers[layers.length - 1] = { name, count: previous.count + 1 };
    return;
  }
  layers.push({ name, count: 1 });
}

function addShadowVoxel(runs: ShadowOpacityRun[], y: number, opacity: number): void {
  if (opacity <= 0) return;
  const previous = runs.at(-1);
  if (previous !== undefined && previous.opacity === opacity && y === previous.minY - 1) {
    runs[runs.length - 1] = { ...previous, minY: y };
    return;
  }
  runs.push({ minY: y, maxY: y, opacity });
}

function blockShadowOpacity(name: string): number {
  if (isDecorativeCover(name) || /torch/.test(name)) return 0;
  if (isWater(name)) return 25 / 255;
  if (/leaves/.test(name)) return 0.6;
  return 1;
}

function isTranslucentGlass(name: string): boolean {
  return /(?:^|:)(?:[a-z_]+_stained_)?glass(?:_pane)?$/.test(name);
}

function isDecorativeCover(name: string): boolean {
  const separator = name.indexOf(":");
  const block = separator === -1 ? name : name.slice(separator + 1);
  return (
    block === "short_grass" ||
    block === "tall_grass" ||
    block === "tallgrass" ||
    block === "grass" ||
    block === "bush" ||
    block === "double_plant" ||
    block === "seagrass" ||
    block === "reeds" ||
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
