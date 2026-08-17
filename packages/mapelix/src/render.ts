import { defaultBlockStyle, type BlockStyleResolver, type RgbaColor } from "./block-style.js";
import { canonicalBiomeId, legacyBiomeStyle, type BiomeStyle } from "./biome-style.js";
import { TILE_SIZE, type SurfaceSamples } from "./tile.js";

export interface RenderSurfaceOptions {
  readonly resolveBlockStyle?: BlockStyleResolver;
  /** Optional artistic extension. The uNmINeD-compatible default is no spatial biome blend. */
  readonly biomeBlendRadius?: number;
  /** Enables the uNmINeD-compatible 3D-opacity cast-shadow pass. Defaults to true. */
  readonly shadows?: boolean;
}

export interface RenderSurfaceContext {
  /** Returns a biome ID outside the current tile for seam-free tint blending. */
  readonly biomeAt?: (x: number, z: number) => number | undefined;
}

const SHADOW_MINIMUM_LIGHT = 0.6;
const SHADOW_SUN_X = -0.353_553_390_593_273_8;
const SHADOW_SUN_Y = 0.707_106_781_186_547_6;
const SHADOW_SUN_Z = -0.612_372_435_695_794_5;
const BIOME_CHANNELS = 14;
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
  const sampleSize = Math.sqrt(samples.length);
  const pixelsPerBlock = TILE_SIZE / sampleSize;
  if (
    !Number.isSafeInteger(sampleSize) ||
    !Number.isSafeInteger(pixelsPerBlock) ||
    pixelsPerBlock < 1
  ) {
    throw new RangeError(
      `Expected a square surface that divides ${TILE_SIZE}, got ${samples.length}`,
    );
  }

  const resolveBlockStyle = options.resolveBlockStyle ?? memoizeBlockStyle(defaultBlockStyle);
  const biomeBlendRadius = options.biomeBlendRadius ?? 0;
  const castShadows = options.shadows ?? true;
  if (!Number.isSafeInteger(biomeBlendRadius) || biomeBlendRadius < 0) {
    throw new RangeError(`Biome blend radius must be a non-negative integer`);
  }
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  const biomeTints =
    biomeBlendRadius === 0
      ? undefined
      : createBiomeTintField(samples, context, sampleSize, biomeBlendRadius);
  const maximumHeight = maximumTerrainHeight(samples);

  for (let z = 0; z < sampleSize; z += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      const index = z * sampleSize + x;
      const sample = samples[index];
      if (sample === undefined) {
        continue;
      }

      const biome = usesBiomeTint(sample)
        ? biomeBlendRadius === 0
          ? legacyBiomeStyle(sample.biomeId!)
          : biomeStyleAt(biomeTints, index)
        : undefined;
      const base = applyElevationGradient(
        resolveSurfaceColor(sample, resolveBlockStyle, biome),
        sample,
      );
      writeSurfaceBlock(
        rgba,
        samples,
        sampleSize,
        pixelsPerBlock,
        maximumHeight,
        castShadows,
        x,
        z,
        base,
      );
    }
  }
  return rgba;
}

function memoizeBlockStyle(resolve: BlockStyleResolver): BlockStyleResolver {
  const colors = new Map<string, RgbaColor>();
  return (name) => {
    const cached = colors.get(name);
    if (cached !== undefined) return cached;
    const blockColor = resolve(name);
    colors.set(name, blockColor);
    return blockColor;
  };
}

function calculateOutputShade(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
  sample: NonNullable<SurfaceSamples[number]>,
  maximumHeight: number,
  castShadows: boolean,
): number {
  const height = reliefHeight(sample);
  const relief =
    pixelsPerBlock === 1
      ? calculateSinglePixelRelief(samples, sampleSize, pixelsPerBlock, outputX, outputZ, height)
      : calculateHeightContour(
          samples,
          sampleSize,
          pixelsPerBlock,
          outputX,
          outputZ,
          height,
          sample,
        );
  if (!castShadows) return relief;
  return (
    relief *
    castOutputShadow(
      samples,
      sampleSize,
      pixelsPerBlock,
      outputX,
      outputZ,
      terrainHeight(sample),
      maximumHeight,
    )
  );
}

function calculateSinglePixelRelief(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
  height: number,
): number {
  const northHeight = outputHeight(
    samples,
    sampleSize,
    pixelsPerBlock,
    outputX,
    outputZ - 1,
    height,
  );
  const southHeight = outputHeight(
    samples,
    sampleSize,
    pixelsPerBlock,
    outputX,
    outputZ + 1,
    height,
  );
  const westHeight = outputHeight(
    samples,
    sampleSize,
    pixelsPerBlock,
    outputX - 1,
    outputZ,
    height,
  );
  const eastHeight = outputHeight(
    samples,
    sampleSize,
    pixelsPerBlock,
    outputX + 1,
    outputZ,
    height,
  );
  const slopeX = clamp((eastHeight - westHeight) * 0.45, -0.8, 0.8);
  const slopeZ = clamp((southHeight - northHeight) * 0.45, -0.8, 0.8);
  const normalLength = Math.hypot(slopeX, 1, slopeZ);
  const light = (-slopeX * -0.45 + 0.78 + -slopeZ * -0.45) / normalLength;
  const hillShade = 1 + (light - 0.78) * 0.62;
  return clamp(hillShade, 0.68, 1.18);
}

function calculateHeightContour(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
  height: number,
  sample: NonNullable<SurfaceSamples[number]>,
): number {
  let shade = 1;
  if (outputX % pixelsPerBlock === 0) {
    shade *= heightStepShade(
      height - outputHeight(samples, sampleSize, pixelsPerBlock, outputX - 1, outputZ, height),
      sample,
    );
  }
  if (outputZ % pixelsPerBlock === 0) {
    shade *= heightStepShade(
      height - outputHeight(samples, sampleSize, pixelsPerBlock, outputX, outputZ - 1, height),
      sample,
    );
  }
  return shade;
}

function heightStepShade(delta: number, sample: NonNullable<SurfaceSamples[number]>): number {
  const magnitude = isWater(sample.name)
    ? (0.15 * (12 - Math.min(sample.fluidDepth ?? 1, 12))) / 12
    : 0.3;
  if (delta > 0) return 1 + magnitude;
  if (delta < 0) return 1 / (1 + magnitude);
  return 1;
}

function outputHeight(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
  fallback: number,
): number {
  const sample = outputSample(samples, sampleSize, pixelsPerBlock, outputX, outputZ);
  return sample === undefined ? fallback : reliefHeight(sample);
}

function castOutputShadow(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
  height: number,
  maximumHeight: number,
): number {
  if (height >= maximumHeight) return 1;

  const originX = (outputX + 0.5) / pixelsPerBlock;
  const originY = height + 255 / 256;
  const originZ = (outputZ + 0.5) / pixelsPerBlock;
  let voxelX = Math.floor(originX);
  let voxelY = Math.floor(originY);
  let voxelZ = Math.floor(originZ);
  let nextX = (originX - voxelX) / -SHADOW_SUN_X;
  let nextY = (voxelY + 1 - originY) / SHADOW_SUN_Y;
  let nextZ = (originZ - voxelZ) / -SHADOW_SUN_Z;
  const stepX = 1 / -SHADOW_SUN_X;
  const stepY = 1 / SHADOW_SUN_Y;
  const stepZ = 1 / -SHADOW_SUN_Z;
  let transmission = 1;

  while (voxelY <= maximumHeight && transmission > 0) {
    const next = Math.min(nextX, nextY, nextZ);
    const crossX = approximatelyEqual(nextX, next);
    const crossY = approximatelyEqual(nextY, next);
    const crossZ = approximatelyEqual(nextZ, next);
    const crossedAxes = (crossX ? 1 : 0) | (crossY ? 2 : 0) | (crossZ ? 4 : 0);
    const followingCrossing = Math.min(
      crossX ? nextX + stepX : nextX,
      crossY ? nextY + stepY : nextY,
      crossZ ? nextZ + stepZ : nextZ,
    );
    const chordScale = (followingCrossing - next) / Math.SQRT2;

    for (
      let combination = crossedAxes;
      combination > 0;
      combination = (combination - 1) & crossedAxes
    ) {
      const candidateX = voxelX - (combination & 1 ? 1 : 0);
      const candidateY = voxelY + (combination & 2 ? 1 : 0);
      const candidateZ = voxelZ - (combination & 4 ? 1 : 0);
      const opacity = shadowOpacityAt(samples, sampleSize, candidateX, candidateY, candidateZ);
      if (opacity >= 1) return SHADOW_MINIMUM_LIGHT;
      if (combination === crossedAxes) {
        transmission *= 1 - opacity * chordScale;
        if (transmission <= 0) return SHADOW_MINIMUM_LIGHT;
      }
    }

    if (crossX) {
      voxelX -= 1;
      nextX += stepX;
    }
    if (crossY) {
      voxelY += 1;
      nextY += stepY;
    }
    if (crossZ) {
      voxelZ -= 1;
      nextZ += stepZ;
    }
    if (voxelX < 0 || voxelX >= sampleSize || voxelZ < 0 || voxelZ >= sampleSize) break;
  }

  return SHADOW_MINIMUM_LIGHT + (1 - SHADOW_MINIMUM_LIGHT) * transmission;
}

function shadowOpacityAt(
  samples: SurfaceSamples,
  sampleSize: number,
  x: number,
  y: number,
  z: number,
): number {
  if (x < 0 || x >= sampleSize || z < 0 || z >= sampleSize) return 0;
  const sample = samples[z * sampleSize + x];
  if (sample === undefined) return 0;
  if (sample.shadowRuns !== undefined) {
    for (const run of sample.shadowRuns) {
      if (y >= run.minY && y <= run.maxY) return run.opacity;
    }
    return 0;
  }
  if (y > terrainHeight(sample)) return 0;
  if (isWater(sample.name)) {
    const depth = sample.fluidDepth ?? 1;
    return y >= sample.y - depth + 1 ? 25 / 255 : 0;
  }
  if (isFoliage(sample.name)) return y === sample.y ? 0.6 : 0;
  return 1;
}

function maximumTerrainHeight(samples: SurfaceSamples): number {
  let maximum = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    if (sample !== undefined) maximum = Math.max(maximum, terrainHeight(sample));
  }
  return maximum;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-10;
}

function outputSample(
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  outputX: number,
  outputZ: number,
): SurfaceSamples[number] {
  if (outputX < 0 || outputX >= TILE_SIZE || outputZ < 0 || outputZ >= TILE_SIZE) {
    return undefined;
  }
  const blockX = Math.floor(outputX / pixelsPerBlock);
  const blockZ = Math.floor(outputZ / pixelsPerBlock);
  if (blockX >= sampleSize || blockZ >= sampleSize) return undefined;
  return samples[blockZ * sampleSize + blockX];
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
    const depth = sample.fluidDepth ?? 1;
    const visibleDepth = Math.min(depth, 12);
    const alpha = depth > 12 ? 255 : Math.floor(179 + (Math.min(depth - 1, 12) / 12) * 76);
    const darkening = 1 - (0.5 * Math.min(Math.max(0, visibleDepth - 7), 22)) / 22;
    const shadedWater = darken(water, darkening);
    if (sample.underwaterName === undefined) {
      return { ...shadedWater, alpha };
    }
    const floor = tintBiome(resolve(sample.underwaterName), sample.underwaterName, biome);
    return compositeBytes(floor, shadedWater, alpha);
  }
  return tintBiome(resolve(sample.name), sample.name, biome);
}

function createBiomeTintField(
  samples: SurfaceSamples,
  context: RenderSurfaceContext,
  sampleSize: number,
  blendRadius: number,
): BiomeTintField | undefined {
  if (!samples.some((sample) => sample !== undefined && usesBiomeTint(sample))) return undefined;
  const extendedSize = sampleSize + blendRadius * 2;
  const stride = extendedSize + 1;
  const integral = new Uint32Array(stride * stride * BIOME_CHANNELS);
  const rowSums = new Uint32Array(BIOME_CHANNELS);

  for (let z = 0; z < extendedSize; z += 1) {
    rowSums.fill(0);
    for (let x = 0; x < extendedSize; x += 1) {
      const biomeId = sampleBiome(samples, sampleSize, x - blendRadius, z - blendRadius, context);
      if (biomeId !== undefined) addBiomeStyle(rowSums, legacyBiomeStyle(biomeId));
      const cell = ((z + 1) * stride + x + 1) * BIOME_CHANNELS;
      const above = (z * stride + x + 1) * BIOME_CHANNELS;
      for (let channel = 0; channel < BIOME_CHANNELS; channel += 1) {
        integral[cell + channel] = integral[above + channel]! + rowSums[channel]!;
      }
    }
  }

  const colors = new Uint8Array(sampleSize * sampleSize * BLENDED_CHANNELS);
  const valid = new Uint8Array(sampleSize * sampleSize);
  const windowSize = blendRadius * 2 + 1;
  for (let z = 0; z < sampleSize; z += 1) {
    for (let x = 0; x < sampleSize; x += 1) {
      const count = rectangleSum(integral, stride, x, z, windowSize, 0);
      if (count === 0) continue;
      const pixel = z * sampleSize + x;
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
  sums[1]! += style.groundGrass.red;
  sums[2]! += style.groundGrass.green;
  sums[3]! += style.groundGrass.blue;
  sums[4]! += style.grass.red;
  sums[5]! += style.grass.green;
  sums[6]! += style.grass.blue;
  sums[7]! += style.foliage.red;
  sums[8]! += style.foliage.green;
  sums[9]! += style.foliage.blue;
  sums[10]! += style.water.red;
  sums[11]! += style.water.green;
  sums[12]! += style.water.blue;
  sums[13]! += Math.round(style.waterOpacity * 255);
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
    groundGrass: packedColor(field.colors, offset),
    grass: packedColor(field.colors, offset + 3),
    foliage: packedColor(field.colors, offset + 6),
    water: packedColor(field.colors, offset + 9),
    waterOpacity: field.colors[offset + 12]! / 255,
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
  sampleSize: number,
  x: number,
  z: number,
  context: RenderSurfaceContext,
): number | undefined {
  const contextualBiome = context.biomeAt?.(x, z);
  if (contextualBiome !== undefined) return contextualBiome;
  if (x >= 0 && x < sampleSize && z >= 0 && z < sampleSize) {
    return samples[z * sampleSize + x]?.biomeId;
  }
  return undefined;
}

function applyElevationGradient(
  base: RgbaColor,
  sample: NonNullable<SurfaceSamples[number]>,
): RgbaColor {
  if (!isElevationStyledGround(sample.name) || isWater(sample.name)) return base;
  const height = terrainHeight(sample);
  if (isDirtPath(sample.name)) return darken(base, elevationLightness(height));
  const mountainOpacity = usesGroundElevationColor(sample) ? clamp((height - 62) / 50, 0, 1) : 0;
  const elevationColor = blend(base, mountainColor(sample.name), mountainOpacity);
  return darken(elevationColor, elevationLightness(height));
}

function terrainHeight(sample: NonNullable<SurfaceSamples[number]>): number {
  return sample.supportY ?? sample.y;
}

function reliefHeight(sample: NonNullable<SurfaceSamples[number]>): number {
  return isWater(sample.name)
    ? terrainHeight(sample) - Math.min(sample.fluidDepth ?? 1, 12)
    : terrainHeight(sample);
}

function mountainColor(name: string): RgbaColor {
  if (/red_sand/.test(name)) return color(195, 92, 34);
  if (/sand/.test(name)) return color(179, 168, 77);
  if (/stone|deepslate/.test(name)) return color(153, 153, 153);
  return color(145, 90, 8);
}

function elevationLightness(height: number): number {
  if (height <= -64) return 0.875;
  if (height <= 30) return interpolate(0.875, 0.925, (height + 64) / 94);
  if (height <= 62) return interpolate(0.925, 1, (height - 30) / 32);
  if (height <= 112) return interpolate(1, 0.925, (height - 62) / 50);
  if (height <= 319) return interpolate(0.925, 0.875, (height - 112) / 207);
  return 0.875;
}

function interpolate(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
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
  if (/grass_block/.test(name)) return { ...biome.groundGrass, alpha: base.alpha };
  if (/(?:^|:)(?:short_grass|tall_grass|tallgrass|fern|large_fern)$/.test(name)) {
    return { ...biome.grass, alpha: base.alpha };
  }
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

function compositeBytes(background: RgbaColor, foreground: RgbaColor, alpha: number): RgbaColor {
  const backgroundAlpha = 255 - alpha;
  return {
    red:
      Math.floor((foreground.red * alpha) / 255) +
      Math.floor((background.red * backgroundAlpha) / 255),
    green:
      Math.floor((foreground.green * alpha) / 255) +
      Math.floor((background.green * backgroundAlpha) / 255),
    blue:
      Math.floor((foreground.blue * alpha) / 255) +
      Math.floor((background.blue * backgroundAlpha) / 255),
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

function isWater(name: string): boolean {
  return name === "minecraft:water" || name === "minecraft:flowing_water";
}

function isDirtPath(name: string): boolean {
  return /(?:dirt|grass)_path/.test(name);
}

function usesGroundElevationColor(sample: NonNullable<SurfaceSamples[number]>): boolean {
  if (!/grass_block|mycelium/.test(sample.name)) return false;
  if (sample.biomeId === undefined) return true;
  const biomeId = canonicalBiomeId(sample.biomeId);
  return ![5, 6, 19, 29, 30, 31, 32, 33, 35, 36, 191].includes(biomeId);
}

function usesBiomeTint(sample: NonNullable<SurfaceSamples[number]>): boolean {
  return (
    sample.biomeId !== undefined &&
    !isDirtPath(sample.name) &&
    sample.name !== "minecraft:cherry_leaves" &&
    (isWater(sample.name) ||
      /grass_block|(?:^|:)(?:short_grass|tall_grass|tallgrass|fern|large_fern)$|leaves|vine/.test(
        sample.name,
      ))
  );
}

function isElevationStyledGround(name: string): boolean {
  if (isDirtPath(name)) return true;
  if (/mossy_cobblestone/.test(name)) return false;
  if (
    /stone_bricks?|planks|stairs|slab|wall|fence|door|trapdoor|button|pressure_plate/.test(name)
  ) {
    return false;
  }
  return /grass_block|moss_block|dirt|podzol|mycelium|mud|sand|gravel|stone|deepslate|terracotta|clay/.test(
    name,
  );
}

function isFoliage(name: string): boolean {
  return /leaves/.test(name);
}

function writeSurfaceBlock(
  target: Uint8Array,
  samples: SurfaceSamples,
  sampleSize: number,
  pixelsPerBlock: number,
  maximumHeight: number,
  castShadows: boolean,
  blockX: number,
  blockZ: number,
  base: RgbaColor,
): void {
  for (let pixelZ = 0; pixelZ < pixelsPerBlock; pixelZ += 1) {
    for (let pixelX = 0; pixelX < pixelsPerBlock; pixelX += 1) {
      const outputX = blockX * pixelsPerBlock + pixelX;
      const outputZ = blockZ * pixelsPerBlock + pixelZ;
      const sample = samples[blockZ * sampleSize + blockX];
      if (sample === undefined) continue;
      const shade = calculateOutputShade(
        samples,
        sampleSize,
        pixelsPerBlock,
        outputX,
        outputZ,
        sample,
        maximumHeight,
        castShadows,
      );
      writeColor(target, (outputZ * TILE_SIZE + outputX) * 4, base, shade);
    }
  }
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
