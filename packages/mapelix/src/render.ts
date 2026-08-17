import { defaultBlockStyle, type BlockStyleResolver, type RgbaColor } from "./block-style.js";
import { legacyBiomeStyle, type BiomeStyle } from "./biome-style.js";
import { TILE_SIZE, type SurfaceSamples } from "./tile.js";

export interface RenderSurfaceOptions {
  readonly resolveBlockStyle?: BlockStyleResolver;
}

export interface RenderSurfaceContext {
  /** Returns a biome ID outside the current tile for seam-free tint blending. */
  readonly biomeAt?: (x: number, z: number) => number | undefined;
}

const BIOME_BLEND_RADIUS = 2;
const BIOME_CHANNELS = 11;
const BLENDED_CHANNELS = BIOME_CHANNELS - 1;

interface BiomeTintField {
  readonly colors: Uint8Array;
  readonly valid: Uint8Array;
}

export function renderSurface(
  samples: SurfaceSamples,
  options: RenderSurfaceOptions = {},
  context: RenderSurfaceContext = {},
): Uint8Array {
  if (samples.length !== TILE_SIZE * TILE_SIZE) {
    throw new RangeError(
      `Expected ${TILE_SIZE * TILE_SIZE} surface samples, got ${samples.length}`,
    );
  }

  const resolveBlockStyle = options.resolveBlockStyle ?? defaultBlockStyle;
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const biomeTints = createBiomeTintField(samples, context);

  for (let z = 0; z < TILE_SIZE; z += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const index = z * TILE_SIZE + x;
      const sample = samples[index];
      if (sample === undefined) {
        continue;
      }

      const biome = usesBiomeTint(sample) ? biomeStyleAt(biomeTints, index) : undefined;
      const base = applyElevationGradient(
        resolveSurfaceColor(sample, resolveBlockStyle, biome),
        sample,
      );
      const shade = calculateShade(samples, x, z, sample.y);
      writeColor(rgba, index * 4, increaseSaturation(base, 1.08), shade);
    }
  }
  return rgba;
}

function calculateShade(samples: SurfaceSamples, x: number, z: number, height: number): number {
  const northHeight = sampleHeight(samples, x, z - 1, height);
  const southHeight = sampleHeight(samples, x, z + 1, height);
  const westHeight = sampleHeight(samples, x - 1, z, height);
  const eastHeight = sampleHeight(samples, x + 1, z, height);
  const slopeX = (eastHeight - westHeight) * 0.06;
  const slopeZ = (southHeight - northHeight) * 0.06;
  const normalLength = Math.hypot(slopeX, 1, slopeZ);
  const light = (-slopeX * -0.45 + 0.78 + -slopeZ * -0.45) / normalLength;
  const hillShade = 1 + (light - 0.78) * 0.78;
  const stepRelief = (height - northHeight) * 0.025 + (height - westHeight) * 0.02;
  const relief = clamp(hillShade + stepRelief, 0.62, 1.34);
  return relief * castShadow(samples, x, z, height);
}

function sampleHeight(samples: SurfaceSamples, x: number, z: number, fallback: number): number {
  if (x < 0 || x >= TILE_SIZE || z < 0 || z >= TILE_SIZE) return fallback;
  return samples[z * TILE_SIZE + x]?.y ?? fallback;
}

function castShadow(samples: SurfaceSamples, x: number, z: number, height: number): number {
  let shadow = 1;
  for (let distance = 1; distance <= 7; distance += 1) {
    const sourceX = x - distance;
    const sourceZ = z - distance;
    if (sourceX < 0 || sourceZ < 0) break;
    const source = samples[sourceZ * TILE_SIZE + sourceX];
    if (source !== undefined) {
      const clearance = source.y - height - distance * 0.7;
      if (clearance > 0) {
        const occluded = clamp(0.88 - clearance * 0.025, 0.58, 0.88);
        const opacity = isFoliage(source.name) ? 0.45 : 1;
        shadow = Math.min(shadow, 1 - (1 - occluded) * opacity);
      }
    }
  }
  return shadow;
}

function resolveSurfaceColor(
  sample: SurfaceSamples[number],
  resolve: BlockStyleResolver,
  biome: BiomeStyle | undefined,
): RgbaColor {
  if (sample === undefined) {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }
  if (isWater(sample.name)) {
    const water = biome?.water ?? resolve(sample.name);
    if (sample.underwaterName === undefined) {
      return { ...water, alpha: Math.round(255 * (biome?.waterOpacity ?? 0.62)) };
    }
    const floor = tintBiome(resolve(sample.underwaterName), sample.underwaterName, biome);
    const depth = sample.fluidDepth ?? 1;
    const opacity = clamp((biome?.waterOpacity ?? 0.52) + Math.min(depth, 8) * 0.035, 0.45, 0.86);
    return blend(floor, darken(water, Math.max(0.72, 1 - depth * 0.025)), opacity);
  }
  return tintBiome(resolve(sample.name), sample.name, biome);
}

function createBiomeTintField(
  samples: SurfaceSamples,
  context: RenderSurfaceContext,
): BiomeTintField | undefined {
  if (!samples.some((sample) => sample !== undefined && usesBiomeTint(sample))) return undefined;
  const extendedSize = TILE_SIZE + BIOME_BLEND_RADIUS * 2;
  const stride = extendedSize + 1;
  const integral = new Uint32Array(stride * stride * BIOME_CHANNELS);
  const rowSums = new Uint32Array(BIOME_CHANNELS);

  for (let z = 0; z < extendedSize; z += 1) {
    rowSums.fill(0);
    for (let x = 0; x < extendedSize; x += 1) {
      const biomeId = sampleBiome(samples, x - BIOME_BLEND_RADIUS, z - BIOME_BLEND_RADIUS, context);
      if (biomeId !== undefined) addBiomeStyle(rowSums, legacyBiomeStyle(biomeId));
      const cell = ((z + 1) * stride + x + 1) * BIOME_CHANNELS;
      const above = (z * stride + x + 1) * BIOME_CHANNELS;
      for (let channel = 0; channel < BIOME_CHANNELS; channel += 1) {
        integral[cell + channel] = integral[above + channel]! + rowSums[channel]!;
      }
    }
  }

  const colors = new Uint8Array(TILE_SIZE * TILE_SIZE * BLENDED_CHANNELS);
  const valid = new Uint8Array(TILE_SIZE * TILE_SIZE);
  const windowSize = BIOME_BLEND_RADIUS * 2 + 1;
  for (let z = 0; z < TILE_SIZE; z += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const count = rectangleSum(integral, stride, x, z, windowSize, 0);
      if (count === 0) continue;
      const pixel = z * TILE_SIZE + x;
      valid[pixel] = 1;
      const output = pixel * BLENDED_CHANNELS;
      for (let channel = 1; channel < BIOME_CHANNELS; channel += 1) {
        colors[output + channel - 1] = Math.round(
          rectangleSum(integral, stride, x, z, windowSize, channel) / count,
        );
      }
    }
  }
  return { colors, valid };
}

function addBiomeStyle(sums: Uint32Array, style: BiomeStyle): void {
  sums[0]! += 1;
  sums[1]! += style.grass.red;
  sums[2]! += style.grass.green;
  sums[3]! += style.grass.blue;
  sums[4]! += style.foliage.red;
  sums[5]! += style.foliage.green;
  sums[6]! += style.foliage.blue;
  sums[7]! += style.water.red;
  sums[8]! += style.water.green;
  sums[9]! += style.water.blue;
  sums[10]! += Math.round(style.waterOpacity * 255);
}

function rectangleSum(
  integral: Uint32Array,
  stride: number,
  x: number,
  z: number,
  size: number,
  channel: number,
): number {
  const topLeft = (z * stride + x) * BIOME_CHANNELS + channel;
  const topRight = (z * stride + x + size) * BIOME_CHANNELS + channel;
  const bottomLeft = ((z + size) * stride + x) * BIOME_CHANNELS + channel;
  const bottomRight = ((z + size) * stride + x + size) * BIOME_CHANNELS + channel;
  return integral[bottomRight]! - integral[topRight]! - integral[bottomLeft]! + integral[topLeft]!;
}

function biomeStyleAt(field: BiomeTintField | undefined, pixel: number): BiomeStyle | undefined {
  if (field === undefined || field.valid[pixel] !== 1) return undefined;
  const offset = pixel * BLENDED_CHANNELS;
  return {
    grass: packedColor(field.colors, offset),
    foliage: packedColor(field.colors, offset + 3),
    water: packedColor(field.colors, offset + 6),
    waterOpacity: field.colors[offset + 9]! / 255,
  };
}

function packedColor(colors: Uint8Array, offset: number): RgbaColor {
  return {
    red: colors[offset]!,
    green: colors[offset + 1]!,
    blue: colors[offset + 2]!,
    alpha: 255,
  };
}

function sampleBiome(
  samples: SurfaceSamples,
  x: number,
  z: number,
  context: RenderSurfaceContext,
): number | undefined {
  const contextualBiome = context.biomeAt?.(x, z);
  if (contextualBiome !== undefined) return contextualBiome;
  if (x >= 0 && x < TILE_SIZE && z >= 0 && z < TILE_SIZE) {
    return samples[z * TILE_SIZE + x]?.biomeId;
  }
  return undefined;
}

function applyElevationGradient(
  base: RgbaColor,
  sample: NonNullable<SurfaceSamples[number]>,
): RgbaColor {
  if (!isNaturalTerrain(sample.name) || isWater(sample.name)) return base;
  const distanceFromSeaLevel = Math.abs(sample.y - 64);
  const strength = clamp((distanceFromSeaLevel / 128) * 0.6, 0, 0.58);
  if (strength === 0) return base;
  return blend(base, elevationColor(sample.y), strength);
}

function elevationColor(height: number): RgbaColor {
  if (height <= 64) return color(74, 128, 91);
  if (height <= 112)
    return interpolateColor(color(128, 164, 75), color(157, 143, 67), (height - 64) / 48);
  if (height <= 176)
    return interpolateColor(color(157, 143, 67), color(163, 105, 53), (height - 112) / 64);
  return interpolateColor(
    color(163, 105, 53),
    color(119, 75, 41),
    clamp((height - 176) / 80, 0, 1),
  );
}

function interpolateColor(from: RgbaColor, to: RgbaColor, amount: number): RgbaColor {
  return blend(from, to, clamp(amount, 0, 1));
}

function color(red: number, green: number, blue: number): RgbaColor {
  return { red, green, blue, alpha: 255 };
}

function tintBiome(
  base: RgbaColor,
  name: string,
  biome: ReturnType<typeof legacyBiomeStyle> | undefined,
): RgbaColor {
  if (biome === undefined) return base;
  if (/grass|moss|azalea/.test(name)) return { ...biome.grass, alpha: base.alpha };
  if (/leaves|vine/.test(name)) return { ...biome.foliage, alpha: base.alpha };
  return base;
}

function blend(background: RgbaColor, foreground: RgbaColor, opacity: number): RgbaColor {
  return {
    red: Math.round(background.red * (1 - opacity) + foreground.red * opacity),
    green: Math.round(background.green * (1 - opacity) + foreground.green * opacity),
    blue: Math.round(background.blue * (1 - opacity) + foreground.blue * opacity),
    alpha: 255,
  };
}

function darken(value: RgbaColor, factor: number): RgbaColor {
  return {
    red: Math.round(value.red * factor),
    green: Math.round(value.green * factor),
    blue: Math.round(value.blue * factor),
    alpha: value.alpha,
  };
}

function increaseSaturation(value: RgbaColor, factor: number): RgbaColor {
  const average = (value.red + value.green + value.blue) / 3;
  return {
    red: Math.round(clamp(average + (value.red - average) * factor, 0, 255)),
    green: Math.round(clamp(average + (value.green - average) * factor, 0, 255)),
    blue: Math.round(clamp(average + (value.blue - average) * factor, 0, 255)),
    alpha: value.alpha,
  };
}

function isWater(name: string): boolean {
  return name === "minecraft:water" || name === "minecraft:flowing_water";
}

function usesBiomeTint(sample: NonNullable<SurfaceSamples[number]>): boolean {
  return (
    sample.biomeId !== undefined &&
    (isWater(sample.name) || /grass|moss|azalea|leaves|vine/.test(sample.name))
  );
}

function isNaturalTerrain(name: string): boolean {
  return /grass|moss|leaves|vine|dirt|podzol|mycelium|mud|sand|gravel|stone|deepslate|terracotta|clay/.test(
    name,
  );
}

function isFoliage(name: string): boolean {
  return /leaves|vine|azalea/.test(name);
}

function writeColor(target: Uint8Array, offset: number, base: RgbaColor, shade: number): void {
  target[offset] = Math.round(clamp(base.red * shade, 0, 255));
  target[offset + 1] = Math.round(clamp(base.green * shade, 0, 255));
  target[offset + 2] = Math.round(clamp(base.blue * shade, 0, 255));
  target[offset + 3] = base.alpha;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
