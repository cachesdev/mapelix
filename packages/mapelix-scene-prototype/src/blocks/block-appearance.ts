import { defaultBlockStyle } from "@mapelix/prototype";
import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";

import { FULL_BOX, PlantSprite, QuadMaterial, type QuadBox } from "../format.js";

/** How a block occupies its cell. Only cubes hide their neighbors and block the sky. */
export type BlockShape =
  | { readonly kind: "empty" }
  | { readonly kind: "cube"; readonly material: SurfaceMaterial }
  | { readonly kind: "box"; readonly box: QuadBox; readonly material: SurfaceMaterial }
  | { readonly kind: "water" }
  | { readonly kind: "glass" }
  | { readonly kind: "plant"; readonly sprite: PlantSprite };

export type SurfaceMaterial =
  | typeof QuadMaterial.Solid
  | typeof QuadMaterial.Foliage
  | typeof QuadMaterial.Emissive;

/** Faces that take their color from the biome instead of the block palette. */
export type BiomeTint = "none" | "ground" | "grass" | "foliage" | "water";

export interface BlockAppearance {
  readonly shape: BlockShape;
  /** Packed sRGB colors for the top, sides, and bottom along the block's axis. */
  readonly top: number;
  readonly side: number;
  readonly bottom: number;
  /** The axis whose two faces show the `top` and `bottom` colors, such as a log's rings. */
  readonly axis: "x" | "y" | "z";
  /** Glass opacity and similar details stay in the style; the mesher only needs the tint. */
  readonly tint: BiomeTint;
  /** Grass blocks tint only their top face. Leaves, plants, and water tint every face. */
  readonly tintTopOnly: boolean;
  /** Soil sides that show a strip of the top color, like grass, podzol, and mycelium. */
  readonly coveredSides: boolean;
}

const EMPTY: BlockShape = { kind: "empty" };
const SOLID: BlockShape = { kind: "cube", material: QuadMaterial.Solid };
const FOLIAGE: BlockShape = { kind: "cube", material: QuadMaterial.Foliage };
const GLOWING: BlockShape = { kind: "cube", material: QuadMaterial.Emissive };

const DIRT = rgb(134, 96, 67);
const STONE = rgb(125, 125, 125);

/** Blocks that are invisible at map scale or have no stable box, such as signs and vines. */
const INVISIBLE =
  /^(?:air|cave_air|void_air|structure_void|barrier|light_block(?:_\d+)?|moving_block|(?:sticky_)?piston_arm_collision|border_block|allow|deny|camera|invisible_bedrock|web|fire|soul_fire|frame|glow_frame|skull|chain|end_rod|lever|ladder|tripwire|trip_wire|tripwire_hook|bell|glow_lichen|sculk_vein|resin_clump|hanging_roots|spore_blossom|frog_spawn|pointed_dripstone|end_portal|end_gateway|portal|cave_vines(?:_body_with_berries|_head_with_berries)?|(?:weeping|twisting)_vines|vine|amethyst_cluster|(?:small|medium|large)_amethyst_bud|.*_(?:sign|hanging_sign|banner|button|head|skull|candle|wall_torch))$|^(?:standing_sign|wall_sign|standing_banner|wall_banner|candle)$/;

const PLANTS: ReadonlyArray<readonly [RegExp, PlantSprite, number, BiomeTint]> = [
  [
    /^(?:short_grass|tall_grass|tallgrass|fern|large_fern|seagrass|bush)$/,
    PlantSprite.Grass,
    rgb(96, 150, 58),
    "grass",
  ],
  [
    /^(?:wheat|carrots|potatoes|beetroot|melon_stem|pumpkin_stem|nether_wart|torchflower_crop|pitcher_crop)$/,
    PlantSprite.Crop,
    rgb(158, 150, 62),
    "none",
  ],
  [/^(?:reeds|sugar_cane|kelp|kelp_plant)$/, PlantSprite.Stalk, rgb(104, 160, 70), "none"],
  [
    /^(?:brown_mushroom|red_mushroom|crimson_roots|warped_roots|nether_sprouts|crimson_fungus|warped_fungus)$/,
    PlantSprite.Mushroom,
    rgb(160, 110, 80),
    "none",
  ],
  [
    /(?:_sapling|^sapling|^deadbush|^dead_bush|^sweet_berry_bush|^firefly_bush|^mangrove_propagule|^short_dry_grass|^tall_dry_grass)$/,
    PlantSprite.Bush,
    rgb(84, 122, 46),
    "none",
  ],
];

const FLOWER_COLORS: ReadonlyArray<readonly [RegExp, number]> = [
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

const FLOWER =
  /^(?:dandelion|yellow_flower|poppy|red_flower|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|pitcher_plant|sunflower|lilac|rose_bush|peony|open_eyeblossom|closed_eyeblossom|cactus_flower)$/;

/** Box shapes in sixteenths. Stairs and doors stay full cubes, which reads well from above. */
const BOXES: ReadonlyArray<readonly [RegExp, QuadBox, SurfaceMaterial]> = [
  [
    /(?:^|_)carpet$|^pink_petals$|^leaf_litter$|^(?:waterlily|lily_pad)$/,
    box(1, 0),
    QuadMaterial.Solid,
  ],
  [/(?:^|_)rail$|^redstone_wire$/, box(1, 0), QuadMaterial.Solid],
  [/_pressure_plate$/, box(1, 1), QuadMaterial.Solid],
  [/^(?:grass_path|dirt_path|farmland)$/, box(15, 0), QuadMaterial.Solid],
  [/(?:^|_)fence(?:_gate)?$/, box(16, 6), QuadMaterial.Solid],
  [/_wall$|^iron_bars$/, box(16, 4), QuadMaterial.Solid],
  [/^(?:chest|trapped_chest|ender_chest|copper_chest)$/, box(14, 1), QuadMaterial.Solid],
  [/^(?:bed|cake|candle_cake)$|_bed$/, box(9, 1), QuadMaterial.Solid],
  [/^(?:lantern|soul_lantern|copper_lantern)$/, box(9, 5), QuadMaterial.Emissive],
  [/(?:^|_)torch$/, box(10, 7), QuadMaterial.Emissive],
  [/^(?:campfire|soul_campfire)$/, box(7, 0), QuadMaterial.Emissive],
  [/^flower_pot$/, box(6, 5), QuadMaterial.Solid],
  [/^enchanting_table$/, box(12, 0), QuadMaterial.Solid],
  [/^(?:stonecutter_block|stonecutter)$/, box(9, 0), QuadMaterial.Solid],
  [/^daylight_detector(?:_inverted)?$/, box(6, 0), QuadMaterial.Solid],
  [/^end_portal_frame$/, box(13, 0), QuadMaterial.Solid],
  [/^(?:sea_pickle|turtle_egg|conduit)$/, box(6, 5), QuadMaterial.Emissive],
  [/^(?:sculk_sensor|calibrated_sculk_sensor|sculk_shrieker)$/, box(8, 0), QuadMaterial.Solid],
  [/^bamboo$/, box(16, 6), QuadMaterial.Solid],
  [/^cactus$/, box(16, 1), QuadMaterial.Solid],
  [/^big_dripleaf$/, box(15, 0), QuadMaterial.Foliage],
  [/^brewing_stand$/, box(14, 7), QuadMaterial.Solid],
];

const GLASS = /(?:^|_)glass(?:_pane)?$|^(?:ice|frosted_ice|slime|honey_block)$/;
const GLOWING_CUBES =
  /^(?:glowstone|sea_lantern|shroomlight|(?:ochre|verdant|pearlescent)_froglight|lit_redstone_lamp|lit_pumpkin|jack_o_lantern|magma|lava|flowing_lava|beacon|respawn_anchor|lit_furnace|lit_smoker|lit_blast_furnace|crying_obsidian|redstone_ore_lit|lit_redstone_ore)$/;

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
  ["crimson", rgb(92, 25, 29), rgb(126, 58, 86)],
  ["warped", rgb(57, 103, 103), rgb(43, 104, 99)],
  ["bamboo", rgb(170, 160, 60), rgb(193, 173, 80)],
] as const;

/** Colors for common natural and building blocks, tuned for lit 3D faces. */
const COLORS: ReadonlyArray<readonly [RegExp, number, number?]> = [
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
  [/^end_stone/, rgb(219, 222, 158)],
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

/**
 * Resolves the 3D look of a Bedrock block from its name and palette states.
 * Legacy names that keep their variant in a state are first mapped to modern names.
 */
export function resolveBlockAppearance(
  name: string,
  states: LittleEndianNbtCompoundValue,
): BlockAppearance {
  const block = canonicalName(localName(name), states);
  const shape = resolveShape(block, states);
  const style = defaultBlockStyle(`minecraft:${block}`);
  const styled = rgb(style.red, style.green, style.blue);

  if (shape.kind === "water") return uniform(shape, rgb(38, 92, 200), "water");
  if (shape.kind === "plant") return plantAppearance(shape, block);

  const wood = woodColors(block);
  if (wood !== undefined) {
    return {
      ...uniform(shape, wood.side),
      top: wood.top,
      bottom: wood.top,
      axis: pillarAxis(states),
    };
  }
  if (block === "grass_block" || block === "grass") {
    return {
      shape,
      top: rgb(92, 142, 63),
      side: DIRT,
      bottom: DIRT,
      axis: "y",
      tint: "ground",
      tintTopOnly: true,
      coveredSides: true,
    };
  }
  if (FOLIAGE_TINTED.test(block)) return uniform(shape, rgb(62, 118, 48), "foliage");

  for (const [pattern, top, side] of COLORS) {
    if (!pattern.test(block)) continue;
    const covered = side === DIRT && top !== DIRT && block !== "farmland";
    return { ...uniform(shape, side ?? top), top, bottom: side ?? top, coveredSides: covered };
  }
  return uniform(shape, styled);
}

const FOLIAGE_TINTED =
  /^(?:leaves|leaves2|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove)_leaves)$/;

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

function resolveShape(block: string, states: LittleEndianNbtCompoundValue): BlockShape {
  if (INVISIBLE.test(block)) return EMPTY;
  if (/^(?:water|flowing_water|bubble_column)$/.test(block)) return { kind: "water" };
  if (GLASS.test(block)) return { kind: "glass" };
  if (/leaves/.test(block) || block === "azalea" || block === "flowering_azalea") return FOLIAGE;
  if (FLOWER.test(block)) return { kind: "plant", sprite: PlantSprite.Flower };
  for (const [pattern, sprite] of PLANTS) {
    if (pattern.test(block)) return { kind: "plant", sprite };
  }
  if (block.endsWith("_slab") && !block.endsWith("double_slab")) {
    const top = states["minecraft:vertical_half"] === "top" || states.top_slot_bit === 1;
    return {
      kind: "box",
      box: { size: 8, inset: 0, anchoredTop: top },
      material: QuadMaterial.Solid,
    };
  }
  if (block === "snow_layer") {
    const layers = typeof states.height === "number" ? states.height + 1 : 1;
    return { kind: "box", box: box(Math.min(16, layers * 2), 0), material: QuadMaterial.Solid };
  }
  if (/(?:^|_)trapdoor$/.test(block)) {
    const top = states.upside_down_bit === 1;
    return {
      kind: "box",
      box: { size: 3, inset: 0, anchoredTop: top },
      material: QuadMaterial.Solid,
    };
  }
  for (const [pattern, quadBox, material] of BOXES) {
    if (pattern.test(block)) return { kind: "box", box: quadBox, material };
  }
  return GLOWING_CUBES.test(block) ? GLOWING : SOLID;
}

function plantAppearance(
  shape: Extract<BlockShape, { kind: "plant" }>,
  block: string,
): BlockAppearance {
  if (shape.sprite === PlantSprite.Flower) {
    const petals = FLOWER_COLORS.find(([pattern]) => pattern.test(block))?.[1] ?? rgb(214, 40, 40);
    return uniform(shape, petals);
  }
  const plant = PLANTS.find(([pattern]) => pattern.test(block));
  return uniform(shape, plant?.[2] ?? rgb(96, 150, 58), plant?.[3] ?? "none");
}

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
function canonicalName(block: string, states: LittleEndianNbtCompoundValue): string {
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

function pillarAxis(states: LittleEndianNbtCompoundValue): "x" | "y" | "z" {
  const axis = states.pillar_axis;
  return axis === "x" || axis === "z" ? axis : "y";
}

function uniform(shape: BlockShape, color: number, tint: BiomeTint = "none"): BlockAppearance {
  return {
    shape,
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

function box(size: number, inset: number): QuadBox {
  return size === 16 && inset === 0 ? FULL_BOX : { size, inset, anchoredTop: false };
}

function darken(color: number): number {
  return rgb(((color >> 16) & 0xff) * 0.85, ((color >> 8) & 0xff) * 0.85, (color & 0xff) * 0.85);
}

export function rgb(red: number, green: number, blue: number): number {
  return (Math.round(red) << 16) | (Math.round(green) << 8) | Math.round(blue);
}
