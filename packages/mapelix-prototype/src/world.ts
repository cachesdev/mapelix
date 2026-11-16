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
import { assertSurfaceRange, type SurfaceRange } from "./surface-range.js";
import { surfaceBlockStyle, type SurfaceBlockStyle } from "./surface-style.js";
import {
  TILE_SIZE,
  floorDiv,
  tileBlockSpan,
  tileBounds,
  type BlockBounds,
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
  /** Stops accepting work and releases resources after draining or aborting accepted renders. */
  close(options?: CloseWorldOptions): Promise<void>;
}

export interface CloseWorldOptions {
  /** Reject queued/running renders with AbortError and stop workers instead of draining them. */
  readonly abort?: boolean;
}

export interface RenderTileOptions extends RenderSurfaceOptions {
  /** Opt-in dimension bounds, included top-Y cut and fixed-slot Data3D layout. */
  readonly surfaceRange?: SurfaceRange;
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

interface SurfaceSubchunk extends DecodedSubchunk {
  readonly styles?: readonly (SurfaceBlockStyle | undefined)[];
}

/** uNmINeD-compatible horizontal input halo for the default 3D shadow pass. */
export const SHADOW_RENDER_HALO = 256;

/**
 * Surface columns of one 16 x 16 chunk, indexed `localZ * 16 + localX`.
 *
 * A chunk surface depends only on the chunk's own records, the surface range and the surface
 * style, so it can be shared by every tile whose input covers the chunk.
 */
export type ChunkSurface = readonly (SurfaceBlock | undefined)[];

/**
 * Optional store of extracted chunk surfaces. One store must only be used with a single record
 * snapshot, dimension, surface range and surface style; callers key it accordingly.
 */
export interface ChunkSurfaceCache {
  /**
   * `biomeScoped` is true when the chunk lies inside the 3 x 3 storage-tile neighbourhood whose
   * biome records a tile render reads. Surfaces computed with and without biome data differ.
   */
  get(chunkX: number, chunkZ: number, biomeScoped: boolean): ChunkSurface | undefined;
  set(chunkX: number, chunkZ: number, biomeScoped: boolean, surface: ChunkSurface): void;
}

type TileRecordGroups = ReadonlyMap<string, readonly EffectiveBedrockRecord[]>;

function groupTileRecords(
  records: Iterable<EffectiveBedrockRecord>,
): Map<string, EffectiveBedrockRecord[]> {
  const tileRecords = new Map<string, EffectiveBedrockRecord[]>();
  for (const record of records) {
    const location = classifyMapRecordKey(record.key);
    if (location === undefined) {
      continue;
    }
    const tileX = floorDiv(location.x, 16);
    const tileY = floorDiv(location.z, 16);
    const tileKey = tileRecordKey(location.dimension, tileX, tileY);
    const group = tileRecords.get(tileKey) ?? [];
    group.push(record);
    tileRecords.set(tileKey, group);
  }
  return tileRecords;
}

class RecordBedrockWorld implements BedrockWorld {
  readonly tileRecords: Map<string, EffectiveBedrockRecord[]>;
  private closed = false;

  constructor(records: Iterable<EffectiveBedrockRecord>) {
    this.tileRecords = groupTileRecords(records);
  }

  async renderTile(
    coordinates: TileCoordinates,
    options: RenderTileOptions = {},
  ): Promise<RenderedTile> {
    if (this.closed) throw new Error("The Bedrock world is closed");
    return renderGroupedTile(this.tileRecords, coordinates, options);
  }

  getTileCoverage(dimension: Dimension): readonly TileCoverage[] {
    if (this.closed) throw new Error("The Bedrock world is closed");
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

  close(): Promise<void> {
    this.closed = true;
    this.tileRecords.clear();
    return Promise.resolve();
  }
}

/**
 * Renders one tile from effective records. Chunks found in `chunkSurfaces` are reused instead of
 * being extracted again, and every chunk extracted from `records` is stored in it. The rendered
 * pixels are identical with or without the store.
 */
export function renderRecordTile(
  records: Iterable<EffectiveBedrockRecord>,
  coordinates: TileCoordinates,
  options: RenderTileOptions = {},
  chunkSurfaces?: ChunkSurfaceCache,
): RenderedTile {
  return renderGroupedTile(groupTileRecords(records), coordinates, options, chunkSurfaces);
}

/** True when a tile render reads the biome records of this chunk. */
export function chunkHasBiomeScope(
  coordinates: TileCoordinates,
  chunkX: number,
  chunkZ: number,
): boolean {
  const bounds = tileBounds(coordinates);
  return (
    Math.abs(floorDiv(chunkX, 16) - floorDiv(bounds.minX, TILE_SIZE)) <= 1 &&
    Math.abs(floorDiv(chunkZ, 16) - floorDiv(bounds.minZ, TILE_SIZE)) <= 1
  );
}

const EMPTY_CHUNK_SURFACE: ChunkSurface = Object.freeze(
  Array.from({ length: 256 }, (): SurfaceBlock | undefined => undefined),
);

function renderGroupedTile(
  tileRecords: TileRecordGroups,
  coordinates: TileCoordinates,
  options: RenderTileOptions,
  chunkSurfaces?: ChunkSurfaceCache,
): RenderedTile {
  const range = options.surfaceRange;
  assertSurfaceRange(range);
  const bounds = tileBounds(coordinates);
  const dimension = DIMENSION_IDS[coordinates.dimension];
  const chunks = new Map<string, SurfaceSubchunk[]>();
  const loadedChunks = new Map<string, { readonly x: number; readonly z: number }>();
  const biomeChunks = new Map<number, Map<number, DecodedData2D>>();
  const biome3DChunks = new Map<number, Map<number, DecodedData3D>>();
  const storageTileX = floorDiv(bounds.minX, TILE_SIZE);
  const storageTileY = floorDiv(bounds.minZ, TILE_SIZE);
  const inputBounds = tileInputBounds(coordinates, options.shadows !== false);

  for (let tileOffsetY = -1; tileOffsetY <= 1; tileOffsetY += 1) {
    for (let tileOffsetX = -1; tileOffsetX <= 1; tileOffsetX += 1) {
      const neighborRecords = tileRecords.get(
        tileRecordKey(dimension, storageTileX + tileOffsetX, storageTileY + tileOffsetY),
      );
      for (const record of neighborRecords ?? []) {
        const mapKey = classifyMapRecordKey(record.key);
        if (mapKey === undefined || mapKey.dimension !== dimension) continue;
        if (mapKey.tag === DATA_2D_TAG) {
          const data = decodeData2D(record.key, record.value);
          if (data !== undefined) setBiomeChunk(biomeChunks, mapKey.x, mapKey.z, data);
        } else if (mapKey.tag === DATA_3D_TAG) {
          const data = decodeData3D(record.key, record.value, {
            repeatBelow: range !== undefined,
          });
          if (data !== undefined) setBiomeChunk(biome3DChunks, mapKey.x, mapKey.z, data);
        }
      }
    }
  }

  const minStorageTileX = floorDiv(inputBounds.minX, TILE_SIZE);
  const minStorageTileY = floorDiv(inputBounds.minZ, TILE_SIZE);
  const maxStorageTileX = floorDiv(inputBounds.maxX - 1, TILE_SIZE);
  const maxStorageTileY = floorDiv(inputBounds.maxZ - 1, TILE_SIZE);
  for (let inputTileY = minStorageTileY; inputTileY <= maxStorageTileY; inputTileY += 1) {
    for (let inputTileX = minStorageTileX; inputTileX <= maxStorageTileX; inputTileX += 1) {
      const records = tileRecords.get(tileRecordKey(dimension, inputTileX, inputTileY));
      for (const record of records ?? []) {
        const mapKey = classifyMapRecordKey(record.key);
        if (mapKey === undefined || mapKey.tag === DATA_2D_TAG) continue;
        if (
          chunkSurfaces !== undefined &&
          mapKey.dimension === dimension &&
          chunkOriginInside(mapKey.x, mapKey.z, inputBounds)
        ) {
          loadedChunks.set(`${mapKey.x},${mapKey.z}`, { x: mapKey.x, z: mapKey.z });
        }
        if (mapKey.tag === DATA_3D_TAG) continue;
        const key = mapKey.tag === SUBCHUNK_TAG ? mapKey : undefined;
        if (
          key === undefined ||
          key.dimension !== dimension ||
          !chunkOriginInside(key.x, key.z, inputBounds) ||
          (range !== undefined && (key.y * 16 > range.topY || key.y * 16 + 15 < range.minY))
        ) {
          continue;
        }

        const decoded = decodeSubchunk(record.key, record.value, {
          includeStates: options.surfaceStyle !== undefined,
        });
        const subchunk: SurfaceSubchunk | undefined =
          decoded === undefined || options.surfaceStyle === undefined
            ? decoded
            : {
                ...decoded,
                styles: decoded.primary.palette.map((name, index) =>
                  surfaceBlockStyle(
                    options.surfaceStyle,
                    name,
                    decoded.primary.states?.[index] ?? {},
                  ),
                ),
              };
        if (subchunk === undefined) continue;
        const chunkKey = `${key.x},${key.z}`;
        const group = chunks.get(chunkKey) ?? [];
        group.push(subchunk);
        chunks.set(chunkKey, group);
      }
    }
  }

  const blockSpan = tileBlockSpan(coordinates.z);
  const inputWidth = inputBounds.maxX - inputBounds.minX;
  const inputHeight = inputBounds.maxZ - inputBounds.minZ;
  const inputSamples = Array.from(
    { length: inputWidth * inputHeight },
    (): SurfaceBlock | undefined => undefined,
  );
  const writeSurface = (chunkX: number, chunkZ: number, surface: ChunkSurface): void =>
    writeChunkSurface(
      inputSamples,
      inputWidth,
      inputHeight,
      inputBounds.minX,
      inputBounds.minZ,
      chunkX,
      chunkZ,
      surface,
    );

  if (chunkSurfaces !== undefined) {
    const minChunkX = -floorDiv(-inputBounds.minX, 16);
    const minChunkZ = -floorDiv(-inputBounds.minZ, 16);
    const maxChunkX = floorDiv(inputBounds.maxX - 1, 16);
    const maxChunkZ = floorDiv(inputBounds.maxZ - 1, 16);
    for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
      for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
        if (loadedChunks.has(`${chunkX},${chunkZ}`)) continue;
        const cached = chunkSurfaces.get(
          chunkX,
          chunkZ,
          chunkHasBiomeScope(coordinates, chunkX, chunkZ),
        );
        if (cached !== undefined) writeSurface(chunkX, chunkZ, cached);
      }
    }
  }

  for (const subchunks of chunks.values()) {
    subchunks.sort((left, right) => right.y - left.y);
    const key = subchunks[0]?.key;
    if (key === undefined) {
      continue;
    }
    const surface = extractChunkSurface(
      subchunks,
      biomeChunks.get(key.x)?.get(key.z),
      biome3DChunks.get(key.x)?.get(key.z),
      range,
    );
    writeSurface(key.x, key.z, surface);
    chunkSurfaces?.set(key.x, key.z, chunkHasBiomeScope(coordinates, key.x, key.z), surface);
  }
  if (chunkSurfaces !== undefined) {
    for (const [chunkKey, chunk] of loadedChunks) {
      if (chunks.has(chunkKey)) continue;
      chunkSurfaces.set(
        chunk.x,
        chunk.z,
        chunkHasBiomeScope(coordinates, chunk.x, chunk.z),
        EMPTY_CHUNK_SURFACE,
      );
    }
  }

  const samples = Array.from(
    { length: blockSpan * blockSpan },
    (_, index): SurfaceBlock | undefined => {
      const x = index % blockSpan;
      const z = Math.floor(index / blockSpan);
      return inputSamples[
        (bounds.minZ + z - inputBounds.minZ) * inputWidth + (bounds.minX + x - inputBounds.minX)
      ];
    },
  );
  let maximumHeight = Number.NEGATIVE_INFINITY;
  for (const sample of inputSamples) {
    if (sample !== undefined) maximumHeight = Math.max(maximumHeight, sample.supportY ?? sample.y);
  }

  const rgba = renderSurface(samples, options, {
    biomeAt: (x, z) => biomeAt(biomeChunks, bounds.minX + x, bounds.minZ + z),
    sampleAt: (x, z) => {
      const inputX = bounds.minX + x - inputBounds.minX;
      const inputZ = bounds.minZ + z - inputBounds.minZ;
      if (inputX < 0 || inputX >= inputWidth || inputZ < 0 || inputZ >= inputHeight) {
        return undefined;
      }
      return inputSamples[inputZ * inputWidth + inputX];
    },
    maximumHeight,
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

function chunkOriginInside(chunkX: number, chunkZ: number, bounds: BlockBounds): boolean {
  return (
    chunkX * 16 >= bounds.minX &&
    chunkX * 16 < bounds.maxX &&
    chunkZ * 16 >= bounds.minZ &&
    chunkZ * 16 < bounds.maxZ
  );
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

export function tileInputBounds(coordinates: TileCoordinates, shadows: boolean): BlockBounds {
  const bounds = tileBounds(coordinates);
  const negativeHalo = shadows ? SHADOW_RENDER_HALO : 1;
  return {
    minX: bounds.minX - negativeHalo,
    minZ: bounds.minZ - negativeHalo,
    maxX: bounds.maxX + 1,
    maxZ: bounds.maxZ + 1,
  };
}

function writeChunkSurface(
  samples: Array<SurfaceBlock | undefined>,
  sampleWidth: number,
  sampleHeight: number,
  tileMinX: number,
  tileMinZ: number,
  chunkX: number,
  chunkZ: number,
  surface: ChunkSurface,
): void {
  for (let localZ = 0; localZ < 16; localZ += 1) {
    const pixelZ = chunkZ * 16 + localZ - tileMinZ;
    if (pixelZ < 0 || pixelZ >= sampleHeight) continue;
    for (let localX = 0; localX < 16; localX += 1) {
      const sample = surface[localZ * 16 + localX];
      if (sample === undefined) continue;
      const pixelX = chunkX * 16 + localX - tileMinX;
      if (pixelX < 0 || pixelX >= sampleWidth) continue;
      samples[pixelZ * sampleWidth + pixelX] = sample;
    }
  }
}

function extractChunkSurface(
  subchunks: readonly SurfaceSubchunk[],
  biomes: DecodedData2D | undefined,
  biomes3D: DecodedData3D | undefined,
  range: SurfaceRange | undefined,
): ChunkSurface {
  const biomeSectionYs =
    range === undefined
      ? subchunks
          .map((subchunk) => subchunk.y)
          .filter((y) => y >= -4 && y <= 19)
          .sort((left, right) => left - right)
      : Array.from(
          { length: (range.maxY - range.minY) / 16 },
          (_, index) => range.minY / 16 + index,
        );
  const columns = Array.from({ length: 256 }, (): SurfaceBlock | undefined => undefined);
  for (let localZ = 0; localZ < 16; localZ += 1) {
    for (let localX = 0; localX < 16; localX += 1) {
      const surface = findSurfaceBlock(subchunks, localX, localZ, range);
      if (surface === undefined) {
        continue;
      }
      const biomeId =
        (biomes3D === undefined
          ? undefined
          : data3DBiomeAt(biomes3D, biomeSectionYs, localX, surface.y, localZ)) ??
        (biomes === undefined ? undefined : data2DBiomeAt(biomes, localX, localZ));
      columns[localZ * 16 + localX] = biomeId === undefined ? surface : { ...surface, biomeId };
    }
  }
  return columns;
}

function findSurfaceBlock(
  subchunks: readonly SurfaceSubchunk[],
  localX: number,
  localZ: number,
  range: SurfaceRange | undefined,
): SurfaceBlock | undefined {
  let decorativeCover: SurfaceBlock | undefined;
  let waterSurface: SurfaceBlock | undefined;
  let surface: SurfaceBlock | undefined;
  let fluidDepth = 0;
  const colorLayers: SurfaceColorLayer[] = [];
  let translucentTopY: number | undefined;
  const shadowRuns: ShadowOpacityRun[] = [];
  for (const subchunk of subchunks) {
    const minLocalY = range === undefined ? 0 : Math.max(0, range.minY - subchunk.y * 16);
    const maxLocalY = range === undefined ? 15 : Math.min(15, range.topY - subchunk.y * 16);
    for (let localY = maxLocalY; localY >= minLocalY; localY -= 1) {
      const blockIndex = localX * 256 + localZ * 16 + localY;
      const paletteIndex = subchunk.primary.indexes[blockIndex];
      const name = paletteIndex === undefined ? undefined : subchunk.primary.palette[paletteIndex];
      const style = paletteIndex === undefined ? undefined : subchunk.styles?.[paletteIndex];
      if (name !== undefined && !isAir(name)) {
        const y = subchunk.y * 16 + localY;
        addShadowVoxel(shadowRuns, y, blockShadowOpacity(name, style));
        if (surface !== undefined) continue;
        if (
          decorativeCover === undefined &&
          waterSurface === undefined &&
          isTranslucentGlass(name, style)
        ) {
          translucentTopY ??= y;
          addColorLayer(colorLayers, name, style);
          continue;
        }
        if (waterSurface !== undefined) {
          if (isWater(name)) {
            fluidDepth += 1;
          } else {
            surface = {
              ...waterSurface,
              fluidDepth,
              underwaterName: name,
              ...(style === undefined ? {} : { underwaterStyle: style }),
            };
          }
          continue;
        }
        if (decorativeCover !== undefined) {
          if (isDecorativeCover(name, style)) continue;
          surface = { ...decorativeCover, supportY: y };
          continue;
        }
        if (isDecorativeCover(name, style)) {
          decorativeCover = { name, y, ...(style === undefined ? {} : { style }) };
          continue;
        }
        if (!isWater(name)) {
          surface = { name, y, ...(style === undefined ? {} : { style }) };
          continue;
        }
        waterSurface = { name, y, ...(style === undefined ? {} : { style }) };
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
        ...(surface.style === undefined ? {} : { style: surface.style }),
        ...(surface.fluidDepth === undefined ? {} : { fluidDepth: surface.fluidDepth }),
        ...(surface.underwaterName === undefined ? {} : { underwaterName: surface.underwaterName }),
        ...(surface.underwaterStyle === undefined
          ? {}
          : { underwaterStyle: surface.underwaterStyle }),
      });
    }
    const top = colorLayers[0]!;
    surface = {
      name: top.name,
      y: translucentTopY!,
      colorLayers,
      ...(top.style === undefined ? {} : { style: top.style }),
    };
  }
  return surface === undefined ? undefined : { ...surface, shadowRuns };
}

function addColorLayer(
  layers: SurfaceColorLayer[],
  name: string,
  style: SurfaceBlockStyle | undefined,
): void {
  const previous = layers.at(-1);
  if (
    previous?.name === name &&
    previous.fluidDepth === undefined &&
    sameStyle(previous.style, style)
  ) {
    layers[layers.length - 1] = { ...previous, count: previous.count + 1 };
    return;
  }
  layers.push({ name, count: 1, ...(style === undefined ? {} : { style }) });
}

function sameStyle(
  left: SurfaceBlockStyle | undefined,
  right: SurfaceBlockStyle | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.biomeTint === right.biomeTint &&
      left.color.red === right.color.red &&
      left.color.green === right.color.green &&
      left.color.blue === right.color.blue &&
      left.color.alpha === right.color.alpha)
  );
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

function blockShadowOpacity(name: string, style: SurfaceBlockStyle | undefined): number {
  if (isDecorativeCover(name, style) || /torch/.test(name)) return 0;
  if (isWater(name)) return 25 / 255;
  if (/leaves/.test(name)) return 0.6;
  return 1;
}

function isTranslucentGlass(name: string, style: SurfaceBlockStyle | undefined): boolean {
  return (
    /(?:^|:)(?:[a-z_]+_stained_)?glass(?:_pane)?$/.test(name) ||
    (style !== undefined && /(?:^|:)stained_glass(?:_pane)?$/.test(name))
  );
}

function isDecorativeCover(name: string, style: SurfaceBlockStyle | undefined): boolean {
  if (style?.decorative === true) return true;
  const separator = name.indexOf(":");
  const block = separator === -1 ? name : name.slice(separator + 1);
  return (
    block === "short_grass" ||
    block === "tall_grass" ||
    block === "tallgrass" ||
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
