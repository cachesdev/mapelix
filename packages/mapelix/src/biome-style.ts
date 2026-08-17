import type { RgbaColor } from "./block-style.js";

export interface BiomeStyle {
  readonly groundGrass: RgbaColor;
  readonly grass: RgbaColor;
  readonly foliage: RgbaColor;
  readonly water: RgbaColor;
  readonly waterOpacity: number;
}

const DEFAULT_STYLE = style("#8eb971", "#71a74d", "#3f76e4", 1);
const PLAINS_STYLE = style("#91bd59", "#77ab2f", "#44aff5", 1);
const RESOLVED_STYLES = new Map<number, BiomeStyle>();

/**
 * Resolves legacy numeric biome IDs used by Bedrock Data2D records.
 *
 * Water colors follow Mojang's vanilla client biome resource data. Grass and
 * foliage colors are compact approximations of the vanilla biome color maps.
 */
export function legacyBiomeStyle(biomeId: number): BiomeStyle {
  const baseId = canonicalBiomeId(biomeId);
  const cached = RESOLVED_STYLES.get(baseId);
  if (cached !== undefined) return cached;
  const selected = CLASSIC_STYLES.get(baseId) ?? BIOME_STYLES.get(baseId) ?? DEFAULT_STYLE;
  const resolved = { ...selected, water: classicWaterColor(baseId), waterOpacity: 1 };
  RESOLVED_STYLES.set(baseId, resolved);
  return resolved;
}

/** Resolves only the old mutated-biome aliases; modern Bedrock IDs remain distinct. */
export function canonicalBiomeId(biomeId: number): number {
  return LEGACY_MUTATION_BASES.get(biomeId) ?? biomeId;
}

const LEGACY_MUTATION_BASES = new Map<number, number>([
  [129, 1],
  [130, 2],
  [131, 3],
  [132, 4],
  [133, 5],
  [134, 6],
  [140, 12],
  [149, 21],
  [151, 23],
  [155, 27],
  [156, 28],
  [157, 29],
  [158, 30],
  [160, 32],
  [161, 33],
  [162, 34],
  [163, 35],
  [164, 36],
  [165, 37],
  [166, 38],
  [167, 39],
]);

const CLASSIC_STYLES = new Map<number, BiomeStyle>([
  [5, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [6, solidStyle([94, 99, 53], [100, 107, 45], [60, 65, 21])],
  [19, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [29, solidStyle([70, 107, 45], [93, 142, 61], [50, 106, 26])],
  [30, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [31, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [32, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [33, solidStyle([121, 163, 117], [73, 137, 66], [43, 89, 43])],
  [35, solidStyle([172, 163, 82], [172, 163, 82], [92, 87, 39])],
  [36, solidStyle([172, 163, 82], [172, 163, 82], [92, 87, 39])],
  [191, solidStyle([94, 99, 53], [100, 107, 45], [60, 65, 21])],
]);

const BIOME_STYLES = new Map<number, BiomeStyle>([
  [0, style("#91bd59", "#77ab2f", "#1787d4", 0.62)],
  [1, PLAINS_STYLE],
  [2, style("#bfb755", "#aea42a", "#32a598", 0.5)],
  [3, style("#8ab689", "#6da36b", "#007bf7", 0.55)],
  [4, style("#79c05a", "#59ae30", "#1e97f2", 0.55)],
  [5, style("#86b783", "#689d71", "#287082", 0.58)],
  [6, style("#6a7039", "#6a7039", "#4c6559", 0.72)],
  [7, style("#91bd59", "#77ab2f", "#0084ff", 0.5)],
  [10, style("#80b497", "#70a58b", "#2570b5", 0.58)],
  [11, style("#80b497", "#70a58b", "#185390", 0.58)],
  [12, style("#80b497", "#70a58b", "#14559b", 0.58)],
  [13, style("#80b497", "#70a58b", "#1156a7", 0.58)],
  [14, style("#55c93f", "#2bbb1d", "#8a8997", 0.52)],
  [15, style("#55c93f", "#2bbb1d", "#818193", 0.52)],
  [16, style("#bfb755", "#aea42a", "#157cab", 0.48)],
  [17, style("#bfb755", "#aea42a", "#1a7aa1", 0.5)],
  [18, style("#79c05a", "#59ae30", "#056bd1", 0.55)],
  [19, style("#86b783", "#689d71", "#236583", 0.58)],
  [20, style("#8ab689", "#6da36b", "#045cd5", 0.55)],
  [21, style("#59c93c", "#30b421", "#14a2c5", 0.5)],
  [22, style("#59c93c", "#30b421", "#1b9ed8", 0.5)],
  [23, style("#64c73f", "#3cad2c", "#1b9ed8", 0.5)],
  [24, style("#91bd59", "#77ab2f", "#1787d4", 0.68)],
  [25, style("#778272", "#667466", "#157cab", 0.5)],
  [26, style("#80b497", "#70a58b", "#14559b", 0.55)],
  [27, style("#88bb66", "#6aa84e", "#1e97f2", 0.55)],
  [28, style("#88bb66", "#6aa84e", "#056bd1", 0.55)],
  [29, style("#507a32", "#3b6727", "#1e97f2", 0.6)],
  [30, style("#80b497", "#70a58b", "#287082", 0.58)],
  [31, style("#80b497", "#70a58b", "#236583", 0.58)],
  [32, style("#86b15c", "#679447", "#287082", 0.58)],
  [33, style("#86b15c", "#679447", "#236583", 0.58)],
  [34, style("#8ab689", "#6da36b", "#007bf7", 0.55)],
  [35, style("#bfb755", "#aea42a", "#2590a8", 0.5)],
  [36, style("#bfb755", "#aea42a", "#2590a8", 0.5)],
  [37, style("#90814d", "#7d703f", "#4e7f81", 0.5)],
  [38, style("#90814d", "#7d703f", "#55809e", 0.5)],
  [39, style("#90814d", "#7d703f", "#55809e", 0.5)],
  [40, style("#91bd59", "#77ab2f", "#02b0e5", 0.45)],
  [41, style("#91bd59", "#77ab2f", "#02b0e5", 0.58)],
  [42, style("#91bd59", "#77ab2f", "#0d96db", 0.5)],
  [43, style("#91bd59", "#77ab2f", "#0d96db", 0.62)],
  [44, style("#80b497", "#70a58b", "#2080c9", 0.54)],
  [45, style("#80b497", "#70a58b", "#2080c9", 0.65)],
  [46, style("#80b497", "#70a58b", "#2570b5", 0.58)],
  [47, style("#80b497", "#70a58b", "#2570b5", 0.68)],
  [178, style("#bfb755", "#aea42a", "#905957", 1)],
  [179, style("#bfb755", "#aea42a", "#905957", 1)],
  [180, style("#bfb755", "#aea42a", "#905957", 1)],
  [181, style("#bfb755", "#aea42a", "#905957", 1)],
  [182, style("#80b497", "#60a17b", "#0e63ab", 1)],
  [183, style("#80b497", "#60a17b", "#0e63ab", 1)],
  [184, style("#80b497", "#60a17b", "#0e63ab", 1)],
  [185, style("#80b497", "#60a17b", "#0e63ab", 1)],
  [186, style("#83bb6d", "#63a948", "#0e63ab", 1)],
  [187, style("#8eb971", "#71a74d", "#44aff5", 1)],
  [188, style("#8ab689", "#6da36b", "#44aff5", 1)],
  [189, style("#9abe4b", "#82ac1e", "#0e63ab", 1)],
  [190, style("#91bd59", "#77ab2f", "#44aff5", 1)],
  [191, style("#6a7039", "#8db127", "#3a7a6a", 1)],
  [192, style("#b6db61", "#b6db61", "#5db7ef", 1)],
]);

function style(grass: string, foliage: string, water: string, waterOpacity: number): BiomeStyle {
  const grassTint = fromHex(grass);
  const foliageTint = fromHex(foliage);
  return {
    groundGrass: multiplyTint(grassTint, 224),
    grass: multiplyTint(grassTint, 224),
    foliage: multiplyTint(foliageTint, 144),
    water: fromHex(water),
    waterOpacity,
  };
}

function solidStyle(
  groundGrass: readonly [number, number, number],
  grass: readonly [number, number, number],
  foliage: readonly [number, number, number],
): BiomeStyle {
  return {
    groundGrass: color(...groundGrass),
    grass: color(...grass),
    foliage: color(...foliage),
    water: color(25, 107, 229),
    waterOpacity: 1,
  };
}

function classicWaterColor(biomeId: number): RgbaColor {
  if (biomeId === 6 || biomeId === 191) return color(75, 102, 82);
  if (biomeId === 0 || biomeId === 24) return color(25, 86, 229);
  if (biomeId === 40 || biomeId === 41) return color(25, 127, 229);
  if (biomeId === 42 || biomeId === 43) return color(25, 117, 229);
  if ([10, 11, 44, 45, 46, 47, 183].includes(biomeId)) return color(8, 70, 215);
  return color(25, 107, 229);
}

function multiplyTint(tint: RgbaColor, base: number): RgbaColor {
  return color(
    Math.floor((base * tint.red) / 255),
    Math.floor((base * tint.green) / 255),
    Math.floor((base * tint.blue) / 255),
  );
}

function color(red: number, green: number, blue: number): RgbaColor {
  return { red, green, blue, alpha: 255 };
}

function fromHex(value: string): RgbaColor {
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
    alpha: 255,
  };
}
