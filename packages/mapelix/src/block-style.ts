export interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export type BlockStyleResolver = (blockName: string) => RgbaColor;

const FIXED_COLORS: ReadonlyArray<readonly [RegExp, RgbaColor]> = [
  [/water|bubble_column/, color(46, 92, 181, 220)],
  [/lava|magma/, color(230, 88, 24)],
  [/(?:dirt|grass)_path/, color(115, 84, 38)],
  [/grass|moss|azalea/, color(92, 142, 63)],
  [/leaves|vine/, color(54, 112, 58)],
  [/sand|sandstone|end_stone/, color(218, 204, 144)],
  [/snow|quartz|calcite|white_/, color(224, 229, 222)],
  [/ice/, color(137, 190, 222, 230)],
  [/deepslate|blackstone|bedrock/, color(67, 69, 72)],
  [/dark_oak_(?:log|wood|planks|stairs|slab)/, color(98, 63, 28)],
  [/spruce_(?:log|wood|planks|stairs|slab)/, color(110, 76, 42)],
  [/(?:^|:)oak_(?:log|wood|planks|stairs|slab)/, color(178, 137, 76)],
  [/(?:cobblestone|stone_bricks?)/, color(127, 127, 127)],
  [/stone|ore|andesite|diorite|granite|gravel/, color(127, 124, 118)],
  [/log|stem|wood|planks|hyphae|bamboo/, color(137, 103, 62)],
  [/dirt|mud|podzol|clay|terracotta/, color(126, 89, 59)],
  [/brick|netherrack|nether_wart/, color(125, 54, 49)],
];

export const defaultBlockStyle: BlockStyleResolver = (blockName) => {
  for (const [pattern, blockColor] of FIXED_COLORS) {
    if (pattern.test(blockName)) {
      return blockColor;
    }
  }

  // Unknown modded and newly-added blocks remain visible without a catalog update.
  let hash = 2_166_136_261;
  for (const character of blockName) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return color(72 + (hash & 63), 72 + ((hash >>> 6) & 63), 72 + ((hash >>> 12) & 63));
};

function color(red: number, green: number, blue: number, alpha = 255): RgbaColor {
  return { red, green, blue, alpha };
}
