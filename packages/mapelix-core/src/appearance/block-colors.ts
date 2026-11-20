import { BEDROCK_BLOCK_COLORS, type SampledBlockColors } from "./bedrock-colors.js";

export type BlockStates = Readonly<Record<string, unknown>>;
export type BiomeTint = "none" | "ground" | "grass" | "foliage" | "water";
export type PlantColorKind = "grass" | "crop" | "stalk" | "mushroom" | "bush";
export type AppearanceColorKind = "block" | "water" | "plant" | "flower" | "foliage";
export interface AppearanceColors {
  readonly top: number;
  readonly side: number;
  readonly bottom: number;
  readonly axis: "x" | "y" | "z";
  readonly tint: BiomeTint;
  readonly tintTopOnly: boolean;
  readonly coveredSides: boolean;
}

const DIRT = rgb(134, 96, 67);
const STONE = rgb(125, 125, 125);
const DYES = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

export const PLANT_COLOR_RULES: ReadonlyArray<
  readonly [RegExp, PlantColorKind, number, BiomeTint]
> = [
  [
    /^(?:short_grass|tall_grass|tallgrass|fern|large_fern|seagrass|bush)$/,
    "grass",
    rgb(96, 150, 58),
    "grass",
  ],
  [
    /^(?:wheat|carrots|potatoes|beetroot|melon_stem|pumpkin_stem|nether_wart|torchflower_crop|pitcher_crop)$/,
    "crop",
    rgb(158, 150, 62),
    "none",
  ],
  [/^(?:reeds|sugar_cane|kelp|kelp_plant)$/, "stalk", rgb(104, 160, 70), "none"],
  [/^(?:brown_mushroom|red_mushroom)$/, "mushroom", rgb(160, 110, 80), "none"],
  [/^crimson_(?:roots|fungus)$/, "mushroom", rgb(166, 39, 49), "none"],
  [/^warped_(?:roots|fungus)$|^nether_sprouts$/, "mushroom", rgb(35, 149, 135), "none"],
  [
    /(?:_sapling|^sapling|^deadbush|^dead_bush|^sweet_berry_bush|^firefly_bush|^mangrove_propagule|^short_dry_grass|^tall_dry_grass)$/,
    "bush",
    rgb(84, 122, 46),
    "none",
  ],
];

export const FLOWER_COLORS: ReadonlyArray<readonly [RegExp, number]> = [
  [/poppy|rose|red_tulip|^red_flower$/, rgb(214, 40, 40)],
  [/dandelion|yellow_flower|sunflower/, rgb(247, 214, 45)],
  [/blue_orchid/, rgb(42, 170, 196)],
  [/allium|lilac|syringa/, rgb(186, 120, 222)],
  [
    /azure_bluet|houstonia|oxeye_daisy|white_tulip|lily_of_the_valley|wildflowers/,
    rgb(236, 236, 226),
  ],
  [/orange_tulip|torchflower|open_eyeblossom/, rgb(240, 132, 40)],
  [/pink_tulip|peony|paeonia|pink_petals|cactus_flower/, rgb(238, 158, 196)],
  [/cornflower/, rgb(70, 104, 220)],
  [/wither_rose|closed_eyeblossom/, rgb(52, 48, 50)],
  [/pitcher_plant/, rgb(96, 140, 190)],
];

export const FLOWER_BLOCKS =
  /^(?:dandelion|yellow_flower|poppy|red_flower|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pitcher_plant|sunflower|lilac|rose_bush|peony|open_eyeblossom|closed_eyeblossom|cactus_flower)$/;

const WOODS = [
  ["oak", rgb(109, 85, 50), rgb(170, 136, 80)],
  ["spruce", rgb(58, 37, 16), rgb(116, 85, 49)],
  ["birch", rgb(216, 215, 210), rgb(193, 179, 135)],
  ["jungle", rgb(85, 67, 25), rgb(170, 121, 84)],
  ["acacia", rgb(103, 96, 86), rgb(168, 90, 50)],
  ["dark_oak", rgb(60, 46, 26), rgb(84, 56, 28)],
  ["mangrove", rgb(84, 67, 41), rgb(117, 54, 48)],
  ["cherry", rgb(54, 33, 44), rgb(226, 178, 172)],
  ["pale_oak", rgb(87, 77, 75), rgb(228, 218, 216)],
  ["poplar", rgb(79, 61, 43), rgb(136, 122, 110)],
  ["crimson", rgb(92, 25, 29), rgb(126, 58, 86)],
  ["warped", rgb(57, 103, 103), rgb(43, 104, 99)],
  ["bamboo", rgb(170, 160, 60), rgb(193, 173, 80)],
] as const;

/** Colors for common natural and building blocks, tuned for lit 3D faces. */
const COLORS: ReadonlyArray<readonly [RegExp, number, number?]> = [
  [/^pale_oak_leaves$/, rgb(117, 122, 115)],
  [/^red_poplar_leaves$/, rgb(154, 44, 39)],
  [/^orange_poplar_leaves$/, rgb(188, 86, 24)],
  [/^yellow_poplar_leaves$/, rgb(215, 134, 40)],
  [/^crimson_nylium$/, rgb(145, 32, 40), rgb(97, 38, 38)],
  [/^warped_nylium$/, rgb(43, 114, 103), rgb(97, 38, 38)],
  [/^nether_wart_block$/, rgb(114, 3, 3)],
  [/^warped_wart_block$/, rgb(21, 111, 106)],
  [/^end_stone/, rgb(219, 222, 158)],
  [/^purpur/, rgb(167, 122, 167)],
  [/^chorus_/, rgb(98, 60, 98)],
  [/^(?:polished_)?blackstone/, rgb(49, 43, 51)],
  [/^(?:smooth_|polished_)?basalt$/, rgb(78, 78, 82)],
  [/^(?:red_)?nether_brick/, rgb(65, 22, 29)],
  [/^ancient_debris$/, rgb(93, 64, 55)],
  [/^(?:dirt|coarse_dirt|rooted_dirt)$/, DIRT],
  [/^podzol$/, rgb(91, 63, 24), DIRT],
  [/^mycelium$/, rgb(111, 99, 105), DIRT],
  [/^(?:grass_path|dirt_path)$/, rgb(148, 122, 65), DIRT],
  [/^farmland$/, rgb(82, 55, 36), DIRT],
  [/^(?:stone|infested_stone|smooth_stone)$/, STONE],
  [/^(?:cobblestone|infested_cobblestone)$|^cobblestone_(?:stairs|slab|wall)$/, rgb(116, 116, 116)],
  [/^mossy_cobblestone/, rgb(104, 118, 86)],
  [/stone_?bricks?|^stonebrick$/, rgb(122, 121, 122)],
  [/^(?:cobbled_)?deepslate/, rgb(76, 76, 80)],
  [/andesite/, rgb(136, 136, 137)],
  [/diorite/, rgb(188, 188, 189)],
  [/granite/, rgb(149, 103, 85)],
  [/^tuff/, rgb(108, 109, 102)],
  [/^calcite$/, rgb(223, 224, 220)],
  [/dripstone/, rgb(134, 107, 92)],
  [/^gravel$/, rgb(131, 127, 126)],
  [/^red_sand$/, rgb(190, 102, 33)],
  [/^sand$/, rgb(219, 207, 163)],
  [/red_sandstone/, rgb(181, 98, 31)],
  [/sandstone/, rgb(216, 203, 155)],
  [/^clay$/, rgb(160, 166, 179)],
  [/^(?:snow|snow_layer|powder_snow)$/, rgb(246, 250, 252)],
  [/^packed_ice$/, rgb(141, 180, 250)],
  [/^blue_ice$/, rgb(116, 167, 253)],
  [/^(?:crying_)?obsidian$/, rgb(20, 16, 30)],
  [/^bedrock$/, rgb(85, 85, 85)],
  [/^netherrack$/, rgb(97, 38, 38)],
  [/^soul_(?:sand|soil)$/, rgb(81, 62, 50)],
  [/^(?:lava|flowing_lava|magma)$/, rgb(232, 110, 24)],
  [/^glowstone$/, rgb(255, 214, 128)],
  [/^sea_lantern$/, rgb(196, 222, 214)],
  [/froglight|shroomlight|lit_pumpkin|jack_o_lantern|lit_redstone_lamp/, rgb(250, 190, 90)],
  [/^hay_block$/, rgb(199, 160, 20)],
  [/^bookshelf$/, rgb(162, 130, 78), rgb(117, 94, 59)],
  [/^pumpkin$|^carved_pumpkin$/, rgb(198, 118, 24)],
  [/^melon_block$|^melon$/, rgb(111, 145, 30)],
  [/^cactus$/, rgb(85, 127, 43)],
  [/^moss_(?:block|carpet)$/, rgb(89, 109, 45)],
  [/^mud$/, rgb(60, 57, 60)],
  [/mud_bricks/, rgb(137, 103, 79)],
  [/^packed_mud$/, rgb(142, 106, 79)],
  [/^(?:brick_block|bricks|brick_stairs|brick_slab|brick_wall)$/, rgb(150, 97, 83)],
  [/quartz/, rgb(235, 229, 222)],
  [/prismarine/, rgb(99, 156, 151)],
  [/^iron_block$/, rgb(220, 220, 220)],
  [/^gold_block$/, rgb(246, 208, 61)],
  [/^diamond_block$/, rgb(98, 237, 228)],
  [/^emerald_block$/, rgb(42, 203, 88)],
  [/^lapis_block$/, rgb(31, 67, 140)],
  [/^redstone_block$/, rgb(175, 24, 5)],
  [/^coal_block$/, rgb(16, 15, 15)],
  [/copper/, rgb(192, 107, 79)],
  [/^(?:furnace|lit_furnace|smoker|blast_furnace|dispenser|dropper|observer)$/, rgb(110, 110, 110)],
  [/^(?:rail|golden_rail|detector_rail|activator_rail)$/, rgb(125, 112, 92)],
  [/^redstone_wire$/, rgb(190, 20, 10)],
  [/^(?:waterlily|lily_pad)$/, rgb(38, 120, 48)],
  [/^pink_petals$/, rgb(238, 158, 196)],
  [/^leaf_litter$/, rgb(150, 110, 60)],
  [/^(?:chest|trapped_chest)$/, rgb(162, 116, 46)],
  [/^bamboo$/, rgb(96, 140, 30)],
  [/^(?:torch|lantern|campfire)$/, rgb(255, 200, 96)],
  [/^soul_(?:torch|lantern|campfire)$/, rgb(96, 220, 230)],
  [/^water$|^flowing_water$|^bubble_column$/, rgb(38, 92, 200)],
];

const FOLIAGE_TINTED =
  /^(?:vine|leaves|leaves2|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove)_leaves)$/;

/** Shared color decisions; geometry and lighting remain in their rendering adapters. */
export function resolveAppearanceColors(
  name: string,
  states: BlockStates,
  kind: AppearanceColorKind,
  fallback: number,
): AppearanceColors {
  const block = canonicalBlockName(name, states);
  if (kind === "water") return uniform(rgb(38, 92, 200), "water");
  if (block === "standing_banner" || block === "wall_banner") {
    // Entity colors use the same normalized dye order as beds; absent metadata is white cloth.
    const value = states.color;
    const dye =
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
    return uniform(BEDROCK_BLOCK_COLORS[`${DYES[dye]}_wool`]!.colors[0]);
  }
  const sampled =
    !name.includes(":") || name.startsWith("minecraft:") ? BEDROCK_BLOCK_COLORS[block] : undefined;
  if (
    sampled !== undefined &&
    /(?:^|_)ore$|copper|blackstone|^(?:bed|lava|flowing_lava|magma|brown_mushroom|red_mushroom|nether_wart|nether_sprouts|(?:crimson|warped)_(?:roots|fungus)|(?:red_)?nether_brick\w*|soul_sand|soul_soil|(?:ochre|verdant|pearlescent)_froglight)$/.test(
      block,
    )
  ) {
    return sampledColors(sampled, states);
  }
  if (kind === "flower")
    return uniform(FLOWER_COLORS.find(([pattern]) => pattern.test(block))?.[1] ?? rgb(214, 40, 40));
  if (kind === "plant") {
    const plant = PLANT_COLOR_RULES.find(([pattern]) => pattern.test(block));
    return uniform(plant?.[2] ?? rgb(96, 150, 58), plant?.[3] ?? "none");
  }
  const wood = woodColors(block);
  if (wood !== undefined)
    return { ...uniform(wood.side), top: wood.top, bottom: wood.top, axis: pillarAxis(states) };
  if (block === "grass_block" || block === "grass")
    return {
      ...uniform(DIRT, "ground"),
      top: rgb(92, 142, 63),
      tintTopOnly: true,
      coveredSides: true,
    };
  if (FOLIAGE_TINTED.test(block)) return uniform(rgb(62, 118, 48), "foliage");
  for (const [pattern, top, side] of COLORS) {
    if (!pattern.test(block)) continue;
    const covered = side === DIRT && top !== DIRT && block !== "farmland";
    return { ...uniform(side ?? top), top, bottom: side ?? top, coveredSides: covered };
  }
  if (sampled !== undefined && kind !== "foliage") return sampledColors(sampled, states);
  return uniform(fallback);
}

function sampledColors(sampled: SampledBlockColors, states: BlockStates): AppearanceColors {
  const variant = sampled.variants?.find((candidate) =>
    Object.entries(candidate.states).every(([key, value]) => states[key] === value),
  );
  const [top, side, bottom] = variant?.colors ?? sampled.colors;
  return { ...uniform(side), top, bottom, axis: pillarAxis(states) };
}

/** Color category without constructing any 3D model. */
export function appearanceColorKind(name: string, states: BlockStates): AppearanceColorKind {
  const block = canonicalBlockName(name, states);
  if (/^(?:water|flowing_water|bubble_column)$/.test(block)) return "water";
  if (/leaves/.test(block) || block === "azalea" || block === "flowering_azalea") return "foliage";
  if (FLOWER_BLOCKS.test(block)) return "flower";
  return PLANT_COLOR_RULES.some(([pattern]) => pattern.test(block)) ? "plant" : "block";
}

const LEGACY_WOOD_SUFFIXES: Readonly<Record<string, string>> = {
  planks: "planks",
  wooden_slab: "slab",
  double_wooden_slab: "double_slab",
  fence: "fence",
  wood: "wood",
};

const LEGACY_DOUBLE_PLANTS: Readonly<Record<string, string>> = {
  sunflower: "sunflower",
  syringa: "lilac",
  grass: "tall_grass",
  fern: "large_fern",
  rose: "rose_bush",
  paeonia: "peony",
};

function woodColors(block: string): { readonly side: number; readonly top: number } | undefined {
  for (const [wood, bark, rings] of WOODS) {
    if (!block.includes(wood) || (wood === "oak" && /dark_oak|pale_oak/.test(block))) continue;
    const stripped = block.startsWith("stripped_");
    if (/_(?:log|stem)$/.test(block)) return { side: stripped ? darken(rings) : bark, top: rings };
    if (/_(?:wood|hyphae)$/.test(block)) {
      const color = stripped ? darken(rings) : bark;
      return { side: color, top: color };
    }
    if (
      /_(?:planks|stairs|slab|double_slab|fence|fence_gate|door|trapdoor|pressure_plate)$/.test(
        block,
      )
    ) {
      return { side: rings, top: rings };
    }
  }
  return undefined;
}

/** Maps pre-flattening Bedrock names, whose variant lives in a state, to modern names. */
function canonicalName(block: string, states: BlockStates): string {
  const state = (key: string): string | undefined => {
    const value = states[key];
    return typeof value === "string" ? value : undefined;
  };
  const color = state("color")?.replace("silver", "light_gray");
  if (
    color !== undefined &&
    /^(?:wool|carpet|concrete|concrete_powder|stained_glass|stained_glass_pane|shulker_box)$/.test(
      block,
    )
  ) {
    return `${color}_${block}`;
  }
  if (color !== undefined && block === "stained_hardened_clay") return `${color}_terracotta`;
  const logType = state("old_log_type") ?? state("new_log_type");
  if (logType !== undefined && (block === "log" || block === "log2")) return `${logType}_log`;
  const leafType = state("old_leaf_type") ?? state("new_leaf_type");
  if (leafType !== undefined && (block === "leaves" || block === "leaves2"))
    return `${leafType}_leaves`;
  const woodType = state("wood_type");
  if (block === "fence_gate") return `${woodType ?? "oak"}_fence_gate`;
  const woodSuffix = LEGACY_WOOD_SUFFIXES[block];
  if (woodType !== undefined && woodSuffix !== undefined) return `${woodType}_${woodSuffix}`;
  const plantType = state("double_plant_type");
  if (block === "double_plant" && plantType !== undefined) {
    return LEGACY_DOUBLE_PLANTS[plantType] ?? "tall_grass";
  }
  if (block === "tallgrass") return state("tall_grass_type") === "fern" ? "fern" : "short_grass";
  const flowerType = state("flower_type");
  if (block === "red_flower" && flowerType !== undefined) {
    return flowerType === "houstonia"
      ? "azure_bluet"
      : flowerType.replace(/^tulip_(\w+)$/, "$1_tulip").replace("orchid", "blue_orchid");
  }
  const stoneType = state("stone_type");
  if (block === "stone" && stoneType !== undefined && stoneType !== "stone") {
    return stoneType.replace(/^(\w+)_smooth$/, "polished_$1");
  }
  if (block === "sand" && state("sand_type") === "red") return "red_sand";
  if (block === "dirt" && state("dirt_type") === "coarse") return "coarse_dirt";
  return block;
}

function pillarAxis(states: BlockStates): "x" | "y" | "z" {
  const axis = states.pillar_axis;
  return axis === "x" || axis === "z" ? axis : "y";
}

export function canonicalBlockName(name: string, states: BlockStates): string {
  return canonicalName(localName(name), states);
}

/** Legacy palette names that encode their visible variant in a block state. */
export const LEGACY_APPEARANCE_BLOCKS = [
  "wool",
  "carpet",
  "concrete",
  "concrete_powder",
  "stained_glass",
  "stained_glass_pane",
  "shulker_box",
  "stained_hardened_clay",
  "log",
  "log2",
  "leaves",
  "leaves2",
  ...Object.keys(LEGACY_WOOD_SUFFIXES),
  "fence_gate",
  "double_plant",
  "tallgrass",
  "red_flower",
  "stone",
  "sand",
  "dirt",
] as const;

/** Finite color-affecting state cases for declarative consumers; resolution stays shared. */
export function appearanceStateVariants(
  block: string,
): Readonly<Record<string, string | number>>[] {
  const variants = BEDROCK_BLOCK_COLORS[block]?.variants?.map((entry) => entry.states) ?? [];
  const keys = Object.keys(BEDROCK_BLOCK_COLORS);
  const woodTypes = keys
    .filter((name) => name.endsWith("_planks"))
    .map((name) => name.slice(0, -7));
  const cases: Readonly<Record<string, string | number>>[] = [...variants];
  const add = (key: string, values: readonly string[]) =>
    cases.push(...values.map((value) => ({ [key]: value })));
  if (
    /^(?:wool|carpet|concrete|concrete_powder|stained_glass|stained_glass_pane|shulker_box|stained_hardened_clay)$/.test(
      block,
    )
  )
    add(
      "color",
      keys
        .filter((name) => name.endsWith("_wool"))
        .map((name) => name.slice(0, -5))
        .concat("silver"),
    );
  if (block === "log" || block === "log2")
    add(block === "log" ? "old_log_type" : "new_log_type", woodTypes);
  if (block === "leaves" || block === "leaves2")
    add(block === "leaves" ? "old_leaf_type" : "new_leaf_type", woodTypes);
  if (Object.hasOwn(LEGACY_WOOD_SUFFIXES, block) || block === "fence_gate")
    add("wood_type", woodTypes);
  if (block === "double_plant") add("double_plant_type", Object.keys(LEGACY_DOUBLE_PLANTS));
  if (block === "tallgrass") add("tall_grass_type", ["fern"]);
  if (block === "red_flower")
    add(
      "flower_type",
      keys
        .filter((name) => FLOWER_BLOCKS.test(name))
        .flatMap((name) => [
          name,
          name
            .replace("azure_bluet", "houstonia")
            .replace("blue_orchid", "orchid")
            .replace(/^(\w+)_tulip$/, "tulip_$1"),
        ]),
    );
  if (block === "stone")
    add(
      "stone_type",
      ["granite", "diorite", "andesite"].flatMap((name) => [name, `${name}_smooth`]),
    );
  if (block === "sand") add("sand_type", ["red"]);
  if (block === "dirt") add("dirt_type", ["coarse"]);
  return cases;
}

function uniform(color: number, tint: BiomeTint = "none"): AppearanceColors {
  return {
    top: color,
    side: color,
    bottom: color,
    axis: "y",
    tint,
    tintTopOnly: false,
    coveredSides: false,
  };
}

function localName(name: string): string {
  const separator = name.indexOf(":");
  return separator === -1 ? name : name.slice(separator + 1);
}

function darken(color: number): number {
  return rgb(((color >> 16) & 0xff) * 0.85, ((color >> 8) & 0xff) * 0.85, (color & 0xff) * 0.85);
}

export function rgb(red: number, green: number, blue: number): number {
  return (Math.round(red) << 16) | (Math.round(green) << 8) | Math.round(blue);
}
