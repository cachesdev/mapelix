import type { RgbaColor } from "./block-style.js";

export interface BiomeStyle {
  readonly grass: RgbaColor;
  readonly foliage: RgbaColor;
  readonly water: RgbaColor;
  readonly waterOpacity: number;
}

const DEFAULT_STYLE = style("#91bd59", "#77ab2f", "#44aff5", 0.55);

/**
 * Resolves legacy numeric biome IDs used by Bedrock Data2D records.
 *
 * Water colors follow Mojang's vanilla client biome resource data. Grass and
 * foliage colors are compact approximations of the vanilla biome color maps.
 */
export function legacyBiomeStyle(biomeId: number): BiomeStyle {
  const baseId = biomeId >= 128 && biomeId < 256 ? biomeId - 128 : biomeId;
  return BIOME_STYLES.get(baseId) ?? DEFAULT_STYLE;
}

const BIOME_STYLES = new Map<number, BiomeStyle>([
  [0, style("#91bd59", "#77ab2f", "#1787d4", 0.62)],
  [1, DEFAULT_STYLE],
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
]);

function style(grass: string, foliage: string, water: string, waterOpacity: number): BiomeStyle {
  return {
    grass: fromHex(grass),
    foliage: fromHex(foliage),
    water: fromHex(water),
    waterOpacity,
  };
}

function fromHex(value: string): RgbaColor {
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
    alpha: 255,
  };
}
