import { legacyBiomeStyle, type RgbaColor } from "@mapelix/prototype";

import { TintCode } from "./block-palette.js";

/** Tints for plains, used where a world stores no biome data. */
const DEFAULT_BIOME = 1;
const cache = new Map<number, Uint32Array>();

/**
 * Packed tint colors for one biome, indexed by `TintCode`. Foliage is brightened
 * because the 2D palette darkens it for flat maps, and 3D faces add their own shade.
 */
export function biomeTints(biomeId: number | undefined): Uint32Array {
  const id = biomeId ?? DEFAULT_BIOME;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const style = legacyBiomeStyle(id);
  const tints = new Uint32Array(5);
  tints[TintCode.Ground] = pack(style.groundGrass, 1);
  tints[TintCode.Grass] = pack(style.grass, 1.05);
  tints[TintCode.Foliage] = pack(style.foliage, 1.3);
  tints[TintCode.Water] = pack(style.water, 1);
  cache.set(id, tints);
  return tints;
}

/** A square window of per-column biome ids, or -1 where no chunk exists. */
export interface BiomeGrid {
  readonly biomes: Int16Array;
  /** Columns per row in `biomes`. */
  readonly stride: number;
}

/**
 * Averages tints over a square neighborhood so biome borders fade over a few blocks.
 * Returns one color array per `TintCode` for the `size` by `size` window at `offset`.
 * Samples may come from outside the window, which keeps region borders seamless.
 */
export function blendColumnTints(
  grid: BiomeGrid,
  offset: number,
  size: number,
  radius: number,
): Uint32Array[] {
  const blended = Array.from({ length: 5 }, () => new Uint32Array(size * size));
  const sums = new Float64Array(5 * 3);
  const fallback = biomeTints(DEFAULT_BIOME);
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      sums.fill(0);
      let samples = 0;
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          const sx = offset + x + dx;
          const sz = offset + z + dz;
          if (sx < 0 || sz < 0 || sx >= grid.stride || sz >= grid.stride) continue;
          const biome = grid.biomes[sz * grid.stride + sx]!;
          if (biome < 0) continue;
          const tints = biomeTints(biome);
          for (let code = TintCode.Ground; code <= TintCode.Water; code += 1) {
            addColor(sums, code, tints[code]!);
          }
          samples += 1;
        }
      }
      for (let code = TintCode.Ground; code <= TintCode.Water; code += 1) {
        blended[code]![z * size + x] =
          samples === 0 ? fallback[code]! : averageColor(sums, code, samples);
      }
    }
  }
  return blended;
}

function addColor(sums: Float64Array, code: number, color: number): void {
  sums[code * 3] = sums[code * 3]! + ((color >> 16) & 0xff);
  sums[code * 3 + 1] = sums[code * 3 + 1]! + ((color >> 8) & 0xff);
  sums[code * 3 + 2] = sums[code * 3 + 2]! + (color & 0xff);
}

function averageColor(sums: Float64Array, code: number, samples: number): number {
  const channel = (offset: number): number => Math.round(sums[code * 3 + offset]! / samples);
  return (channel(0) << 16) | (channel(1) << 8) | channel(2);
}

function pack(color: RgbaColor, gain: number): number {
  const channel = (value: number): number => Math.min(255, Math.round(value * gain));
  return (channel(color.red) << 16) | (channel(color.green) << 8) | channel(color.blue);
}
