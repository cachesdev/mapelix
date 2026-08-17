export interface RgbaColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha: number;
}

export type BlockStyleResolver = (blockName: string) => RgbaColor;

const FIXED_COLORS: ReadonlyArray<readonly [RegExp, RgbaColor]> = [
  [/water|bubble_column/, color(10, 83, 193, 220)],
  [/lava|magma/, color(230, 88, 24)],
  [/(?:^|:)(?:waxed_)?lightning_rod$/, color(216, 38, 38)],
  [/(?:^|:)(?:waxed_)?weathered_lightning_rod$/, color(89, 165, 108)],
  [/(?:^|:)(?:waxed_)?oxidized_lightning_rod$/, color(82, 172, 139)],
  [/soul_(?:torch|lantern)/, color(50, 254, 255)],
  [/redstone_torch/, color(255, 50, 50)],
  [/(?:lamp|lantern|torch|glowstone|froglight)/, color(255, 234, 50)],
  [/(?:^|:)cornflower$/, color(61, 171, 244)],
  [/(?:^|:)double_plant$/, color(140, 214, 91)],
  [/(?:^|:)brown_mushroom$/, color(122, 104, 30)],
  [/(?:^|:)seagrass$/, color(105, 169, 8)],
  [
    /(?:^|:)bamboo_(?:block|planks|mosaic|stairs|slab|double_slab|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|wall_sign)/,
    color(153, 132, 50),
  ],
  [/(?:^|:)(?:bamboo|reeds)$/, color(132, 163, 40)],
  [
    /(?:^|:)acacia_(?:log|wood|planks|stairs|slab|double_slab|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|wall_sign)/,
    color(158, 79, 45),
  ],
  [/(?:^|:)yellow_terracotta$/, color(169, 154, 96)],
  [/light_blue_(?:wool|bed)/, color(124, 189, 232)],
  [/light_gray_(?:wool|bed)|silver_(?:wool|bed)/, color(127, 127, 127)],
  [/white_(?:wool|bed)/, color(229, 229, 229)],
  [/orange_(?:wool|bed)/, color(234, 136, 71)],
  [/magenta_(?:wool|bed)/, color(232, 124, 232)],
  [/yellow_(?:wool|bed)/, color(232, 210, 124)],
  [/lime_(?:wool|bed)/, color(136, 234, 71)],
  [/pink_(?:wool|bed)/, color(232, 124, 167)],
  [/(?:^|:)gray_(?:wool|bed)/, color(89, 89, 89)],
  [/cyan_(?:wool|bed)/, color(30, 173, 173)],
  [/purple_(?:wool|bed)/, color(116, 30, 173)],
  [/(?:^|:)blue_(?:wool|bed)/, color(30, 30, 173)],
  [/brown_(?:wool|bed)/, color(173, 116, 30)],
  [/green_(?:wool|bed)/, color(87, 173, 30)],
  [/(?:^|:)red_(?:wool|bed)/, color(173, 30, 30)],
  [/black_(?:wool|bed)/, color(25, 25, 25)],
  [/(?:poppy|red_tulip|rose_bush)/, color(244, 61, 61)],
  [/(?:dandelion|sunflower)/, color(244, 226, 61)],
  [/(?:flower|tulip|orchid|allium|azure_bluet|daisy|cornflower|lily)/, color(140, 214, 91)],
  [/(?:wheat|beetroot|carrot|potato|farmland)/, color(163, 126, 40)],
  [/hay_block/, color(216, 216, 216)],
  [/(?:dirt|grass)_path/, color(115, 84, 38)],
  [/cherry_leaves/, color(245, 137, 191)],
  [
    /(?:^|:)(?:grass_block|short_grass|tall_grass|tallgrass|moss_block|moss_carpet)|azalea/,
    color(92, 142, 63),
  ],
  [/leaves|vine/, color(54, 112, 58)],
  [/sand|sandstone|end_stone/, color(218, 204, 144)],
  [/snow|quartz|calcite|white_/, color(224, 229, 222)],
  [/ice/, color(137, 190, 222, 230)],
  [/deepslate|blackstone|bedrock/, color(67, 69, 72)],
  [/dark_oak_(?:log|wood|planks|stairs|slab)/, color(98, 63, 28)],
  [/spruce_(?:log|wood|planks|stairs|slab)/, color(110, 76, 42)],
  [
    /(?:^|:)(?:stripped_)?oak_(?:log|wood|planks|stairs|slab|fence|fence_gate|door|trapdoor|button|pressure_plate|sign|wall_sign)/,
    color(178, 137, 76),
  ],
  [/(?:cobblestone|stone_bricks?)/, color(127, 127, 127)],
  [/(?:^|:)(?:brick_block|bricks?|brick_(?:stairs|slab|wall))/, color(197, 105, 82)],
  [/gravel/, color(130, 126, 124)],
  [/stone|ore|andesite|diorite|granite/, color(127, 124, 118)],
  [/log|stem|wood|planks|hyphae/, color(191, 153, 63)],
  [/(?:^|:)trapdoor$/, color(191, 153, 63)],
  [/(?:^|:)dirt$|podzol/, color(142, 126, 61)],
  [/mud|clay|terracotta/, color(126, 89, 59)],
  [/brick|netherrack|nether_wart/, color(125, 54, 49)],
];

const STAINED_GLASS_COLORS: Readonly<Record<string, RgbaColor>> = {
  white: color(229, 229, 229, 127),
  orange: color(234, 136, 71, 127),
  magenta: color(232, 124, 232, 127),
  light_blue: color(124, 189, 232, 127),
  yellow: color(232, 210, 124, 127),
  lime: color(136, 234, 71, 127),
  pink: color(232, 124, 167, 127),
  gray: color(89, 89, 89, 127),
  light_gray: color(127, 127, 127, 127),
  silver: color(127, 127, 127, 127),
  cyan: color(30, 173, 173, 127),
  purple: color(116, 30, 173, 127),
  blue: color(30, 30, 173, 127),
  brown: color(173, 116, 30, 127),
  green: color(87, 173, 30, 127),
  red: color(173, 30, 30, 127),
  black: color(25, 25, 25, 127),
};

const STAINED_GLASS_PATTERN =
  /(?:^|:)(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|silver|cyan|purple|blue|brown|green|red|black)_stained_glass(?:_pane)?$/;
const DYED_CONCRETE_PATTERN =
  /(?:^|:)(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|silver|cyan|purple|blue|brown|green|red|black)_concrete(?:_powder)?$/;

export const defaultBlockStyle: BlockStyleResolver = (blockName) => {
  const stainedGlass = STAINED_GLASS_PATTERN.exec(blockName);
  if (stainedGlass?.[1] !== undefined) {
    const blockColor = STAINED_GLASS_COLORS[stainedGlass[1]];
    if (blockColor !== undefined) return blockColor;
  }
  const dyedConcrete = DYED_CONCRETE_PATTERN.exec(blockName);
  if (dyedConcrete?.[1] !== undefined) {
    const blockColor = STAINED_GLASS_COLORS[dyedConcrete[1]];
    if (blockColor !== undefined) return { ...blockColor, alpha: 255 };
  }
  if (/(?:^|:)glass(?:_pane)?$/.test(blockName)) return color(216, 216, 216, 127);
  for (const [pattern, blockColor] of FIXED_COLORS) {
    if (pattern.test(blockName)) {
      return blockColor;
    }
  }

  // uNmINeD's default artificial style is HSL(0, 0%, 85%).
  return color(216, 216, 216);
};

function color(red: number, green: number, blue: number, alpha = 255): RgbaColor {
  return { red, green, blue, alpha };
}
