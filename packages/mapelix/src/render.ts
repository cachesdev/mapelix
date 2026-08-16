import { defaultBlockStyle, type BlockStyleResolver, type RgbaColor } from "./block-style.js";
import { legacyBiomeStyle } from "./biome-style.js";
import { TILE_SIZE, type SurfaceSamples } from "./tile.js";

export interface RenderSurfaceOptions {
  readonly resolveBlockStyle?: BlockStyleResolver;
}

export function renderSurface(
  samples: SurfaceSamples,
  options: RenderSurfaceOptions = {},
): Uint8Array {
  if (samples.length !== TILE_SIZE * TILE_SIZE) {
    throw new RangeError(
      `Expected ${TILE_SIZE * TILE_SIZE} surface samples, got ${samples.length}`,
    );
  }

  const resolveBlockStyle = options.resolveBlockStyle ?? defaultBlockStyle;
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  for (let z = 0; z < TILE_SIZE; z += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const index = z * TILE_SIZE + x;
      const sample = samples[index];
      if (sample === undefined) {
        continue;
      }

      const base = resolveSurfaceColor(sample, resolveBlockStyle);
      const shade = calculateShade(samples, x, z, sample.y);
      writeColor(rgba, index * 4, increaseSaturation(base, 1.08), shade);
    }
  }
  return rgba;
}

function calculateShade(samples: SurfaceSamples, x: number, z: number, height: number): number {
  const northHeight = z > 0 ? samples[(z - 1) * TILE_SIZE + x]?.y : undefined;
  const westHeight = x > 0 ? samples[z * TILE_SIZE + x - 1]?.y : undefined;
  const northDelta = northHeight === undefined ? 0 : height - northHeight;
  const westDelta = westHeight === undefined ? 0 : height - westHeight;
  const relief = clamp(1 + northDelta * 0.045 + westDelta * 0.035, 0.68, 1.28);
  return relief * castShadow(samples, x, z, height);
}

function castShadow(samples: SurfaceSamples, x: number, z: number, height: number): number {
  let shadow = 1;
  for (let distance = 1; distance <= 7; distance += 1) {
    const sourceX = x - distance;
    const sourceZ = z - distance;
    if (sourceX < 0 || sourceZ < 0) break;
    const sourceHeight = samples[sourceZ * TILE_SIZE + sourceX]?.y;
    if (sourceHeight !== undefined) {
      const clearance = sourceHeight - height - distance * 0.7;
      if (clearance > 0) {
        shadow = Math.min(shadow, clamp(0.88 - clearance * 0.025, 0.58, 0.88));
      }
    }
  }
  return shadow;
}

function resolveSurfaceColor(
  sample: SurfaceSamples[number],
  resolve: BlockStyleResolver,
): RgbaColor {
  if (sample === undefined) {
    return { red: 0, green: 0, blue: 0, alpha: 0 };
  }
  const biome = sample.biomeId === undefined ? undefined : legacyBiomeStyle(sample.biomeId);
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

function writeColor(target: Uint8Array, offset: number, base: RgbaColor, shade: number): void {
  target[offset] = Math.round(clamp(base.red * shade, 0, 255));
  target[offset + 1] = Math.round(clamp(base.green * shade, 0, 255));
  target[offset + 2] = Math.round(clamp(base.blue * shade, 0, 255));
  target[offset + 3] = base.alpha;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
