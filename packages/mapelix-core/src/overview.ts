import { MAP_TILE_SIZE, mapTileBounds, mapTileAncestor } from "./tile-grid.js";
import type { TileCoordinates } from "./types.js";

export interface OverviewSourceTile {
  readonly coordinates: TileCoordinates;
  /** Straight-alpha, eight-bit RGBA for exactly one 256px zoom-0 tile. */
  readonly rgba: Uint8Array;
}

/** Exact area sums from zoom zero; no intermediate PNG rounding or world-sized mosaic. */
export class OverviewAccumulator {
  private readonly scale: number;
  private readonly sums: Uint32Array;
  private readonly seen = new Set<string>();
  readonly coordinates: TileCoordinates;

  constructor(coordinates: TileCoordinates) {
    mapTileBounds(coordinates);
    if (coordinates.z >= 0) throw new RangeError("Overview zoom must be within -4..-1");
    this.coordinates = Object.freeze({ ...coordinates });
    this.sums = new Uint32Array(MAP_TILE_SIZE * MAP_TILE_SIZE * 4);
    this.scale = 2 ** -coordinates.z;
  }

  add(source: OverviewSourceTile): void {
    const { coordinates, rgba } = source;
    if (coordinates.z !== 0 || coordinates.dimension !== this.coordinates.dimension) {
      throw new RangeError("An overview requires zoom-0 sources from the same dimension");
    }
    const ancestor = mapTileAncestor(coordinates, this.coordinates.z);
    if (ancestor.x !== this.coordinates.x || ancestor.y !== this.coordinates.y)
      throw new RangeError("Source tile is outside the overview bounds");
    if (rgba.byteLength !== MAP_TILE_SIZE * MAP_TILE_SIZE * 4)
      throw new RangeError("An overview source must be 256px RGBA");
    const key = `${coordinates.x}/${coordinates.y}`;
    if (this.seen.has(key)) throw new Error("Duplicate overview source tile");
    this.seen.add(key);
    const { scale, sums } = this;
    const outputX = ((coordinates.x - this.coordinates.x * scale) * MAP_TILE_SIZE) / scale;
    const outputY = ((coordinates.y - this.coordinates.y * scale) * MAP_TILE_SIZE) / scale;
    for (let y = 0; y < MAP_TILE_SIZE; y++) {
      const outputRow = (outputY + Math.floor(y / scale)) * MAP_TILE_SIZE;
      for (let x = 0; x < MAP_TILE_SIZE; x++) {
        const input = (y * MAP_TILE_SIZE + x) * 4;
        const output = (outputRow + outputX + Math.floor(x / scale)) * 4;
        const alpha = rgba[input + 3]!;
        // At most 16*16 samples per output pixel: every sum fits exactly in Uint32.
        sums[output] = sums[output]! + rgba[input]! * alpha;
        sums[output + 1] = sums[output + 1]! + rgba[input + 1]! * alpha;
        sums[output + 2] = sums[output + 2]! + rgba[input + 2]! * alpha;
        sums[output + 3] = sums[output + 3]! + alpha;
      }
    }
  }

  finish(): Uint8Array {
    const rgba = new Uint8Array(MAP_TILE_SIZE * MAP_TILE_SIZE * 4);
    for (let offset = 0; offset < rgba.byteLength; offset += 4) {
      const sumAlpha = this.sums[offset + 3]!;
      const alpha = Math.round(sumAlpha / (this.scale * this.scale));
      if (alpha === 0) continue;
      rgba[offset] = Math.round(this.sums[offset]! / sumAlpha);
      rgba[offset + 1] = Math.round(this.sums[offset + 1]! / sumAlpha);
      rgba[offset + 2] = Math.round(this.sums[offset + 2]! / sumAlpha);
      rgba[offset + 3] = alpha;
    }
    return rgba;
  }
}
