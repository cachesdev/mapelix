import { EMPTY_HEIGHT, Face, QuadMaterial } from "../format.js";
import { decodeSection, type ChunkSource } from "../world/chunk-source.js";
import { biomeTints } from "./biome-tints.js";
import { BlockPalette, Shape, TintCode } from "./block-palette.js";

/** Water deeper than this is treated as having a dark floor, so oceans stay cheap to scan. */
const MAX_WATER_DEPTH = 32;
const OCEAN_FLOOR = 0x3c4436;

/**
 * The visible layers of every column in one chunk, indexed `localZ * 16 + localX`.
 * Heights are the y of the top face, so a grass block at y = 70 has height 71.
 */
export interface ChunkSurface {
  /** The terrain, below any leaves. */
  readonly ground: Int16Array;
  readonly top: Uint32Array;
  readonly side: Uint32Array;
  /** 1 where the ground block's sides are soil under a strip of its top color. */
  readonly covered: Uint8Array;
  /** Top of the highest leaves above the ground, or `EMPTY_HEIGHT` under open sky. */
  readonly canopy: Int16Array;
  /** The y of the lowest leaf block above the ground. */
  readonly canopyBottom: Int16Array;
  readonly canopyColor: Uint32Array;
  /** Water surface height, or `EMPTY_HEIGHT` for dry columns. */
  readonly water: Int16Array;
  readonly waterColor: Uint32Array;
}

/** Scans chunk surfaces from the top down, decoding only the subchunks it needs. */
export class SurfaceSource {
  private readonly chunks: ChunkSource;
  private readonly palette: BlockPalette;
  private readonly cache = new Map<string, ChunkSurface | undefined>();
  private readonly maxCachedChunks: number;
  /** Color of a snow layer or carpet waiting for the block it rests on, or -1. */
  private readonly layerColor = new Int32Array(256);

  constructor(chunks: ChunkSource, palette: BlockPalette, maxCachedChunks = 8192) {
    this.chunks = chunks;
    this.palette = palette;
    this.maxCachedChunks = maxCachedChunks;
  }

  surface(chunkX: number, chunkZ: number): ChunkSurface | undefined {
    const id = `${chunkX},${chunkZ}`;
    if (this.cache.has(id)) return this.cache.get(id);
    const surface = this.scan(chunkX, chunkZ);
    this.cache.set(id, surface);
    if (this.cache.size > this.maxCachedChunks) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return surface;
  }

  private scan(chunkX: number, chunkZ: number): ChunkSurface | undefined {
    const records = this.chunks.records(chunkX, chunkZ);
    if (records === undefined) return undefined;
    const surface: ChunkSurface = {
      ground: new Int16Array(256).fill(EMPTY_HEIGHT),
      top: new Uint32Array(256),
      side: new Uint32Array(256),
      covered: new Uint8Array(256),
      canopy: new Int16Array(256).fill(EMPTY_HEIGHT),
      canopyBottom: new Int16Array(256),
      canopyColor: new Uint32Array(256),
      water: new Int16Array(256).fill(EMPTY_HEIGHT),
      waterColor: new Uint32Array(256),
    };
    this.layerColor.fill(-1);

    let unresolved = 256;
    for (const section of records.sections) {
      if (unresolved === 0) break;
      const decoded = decodeSection(section);
      if (decoded === undefined) continue;
      const storage = decoded.primary;
      const ids = Uint16Array.from(storage.palette, (name, index) =>
        this.palette.idFor(name, storage.states?.[index]),
      );
      if (ids.every((id) => this.palette.shape[id] === Shape.Empty)) continue;

      for (let column = 0; column < 256; column += 1) {
        if (surface.ground[column] !== EMPTY_HEIGHT) continue;
        const localX = column & 15;
        const localZ = column >> 4;
        for (let localY = 15; localY >= 0; localY -= 1) {
          const id = ids[storage.indexes[localX * 256 + localZ * 16 + localY]!]!;
          const y = decoded.y * 16 + localY;
          if (this.resolve(surface, column, id, y, records.biomes.at(localX, y, localZ))) {
            unresolved -= 1;
            break;
          }
        }
      }
    }
    return surface;
  }

  /**
   * Records one block of a column scan, from the top down. Leaves and water are
   * noted on the way, and the scan ends at the ground. Returns true once it is known.
   */
  private resolve(
    surface: ChunkSurface,
    column: number,
    id: number,
    y: number,
    biome: number | undefined,
  ): boolean {
    const shape = this.palette.shape[id]!;
    if (shape === Shape.Empty || shape === Shape.Plant) return false;
    // Thin layers such as snow and carpets color the block they rest on.
    if (shape === Shape.Box && this.palette.boxSize[id]! < 8) {
      if (this.layerColor[column] === -1) {
        this.layerColor[column] = this.faceColor(id, Face.PositiveY, biome);
      }
      return false;
    }
    const layer = this.layerColor[column]!;
    this.layerColor[column] = -1;

    if (this.palette.material[id] === QuadMaterial.Foliage) {
      // Leaves under water are part of the water bed.
      if (surface.water[column] !== EMPTY_HEIGHT) return false;
      if (surface.canopy[column] === EMPTY_HEIGHT) {
        surface.canopy[column] = y + 1;
        surface.canopyColor[column] =
          layer === -1 ? this.faceColor(id, Face.PositiveY, biome) : layer;
      }
      surface.canopyBottom[column] = y;
      return false;
    }
    if (shape === Shape.Water) {
      if (surface.water[column] === EMPTY_HEIGHT) {
        surface.water[column] = y + 1;
        surface.waterColor[column] = biomeTints(biome)[TintCode.Water]!;
      } else if (surface.water[column]! - y > MAX_WATER_DEPTH) {
        surface.ground[column] = y;
        surface.top[column] = OCEAN_FLOOR;
        surface.side[column] = OCEAN_FLOOR;
        return true;
      }
      return false;
    }

    surface.ground[column] = y + 1;
    surface.top[column] = layer === -1 ? this.faceColor(id, Face.PositiveY, biome) : layer;
    surface.side[column] = this.faceColor(id, Face.PositiveX, biome);
    surface.covered[column] = this.palette.covered[id]!;
    return true;
  }

  private faceColor(id: number, face: number, biome: number | undefined): number {
    const tint = this.palette.tints[id * 6 + face]!;
    return tint === TintCode.None ? this.palette.colors[id * 6 + face]! : biomeTints(biome)[tint]!;
  }
}
