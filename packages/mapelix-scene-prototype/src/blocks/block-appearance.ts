import { defaultBlockStyle } from "@mapelix/prototype";
import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";

import { FULL_BOX, PlantSprite, QuadMaterial, type QuadBox } from "../format.js";
import {
  canonicalBlockName,
  resolveAppearanceColors,
  PLANT_COLOR_RULES,
  FLOWER_BLOCKS as FLOWER,
  rgb,
  type BiomeTint,
} from "@mapelix/core/appearance";
export type { BiomeTint } from "@mapelix/core/appearance";
import { COPPER_PREFIX, resolveBlockModel, type BlockModel } from "./block-models.js";

/** How a block occupies its cell. Only cubes hide their neighbors and block the sky. */
export type BlockShape =
  | { readonly kind: "empty" }
  | { readonly kind: "cube"; readonly material: SurfaceMaterial }
  | { readonly kind: "box"; readonly box: QuadBox; readonly material: SurfaceMaterial }
  | { readonly kind: "water" }
  | { readonly kind: "glass" }
  | { readonly kind: "plant"; readonly sprite: PlantSprite }
  | {
      readonly kind: "model";
      readonly model: BlockModel;
      readonly material: SurfaceMaterial | typeof QuadMaterial.Glass;
    }
  | { readonly kind: "lava"; readonly level: number };

export type SurfaceMaterial =
  | typeof QuadMaterial.Solid
  | typeof QuadMaterial.Foliage
  | typeof QuadMaterial.Emissive;

/** Faces that take their color from the biome instead of the block palette. */

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

/** Blocks that are invisible at map scale or have no stable box, such as signs and vines. */
const INVISIBLE =
  /^(?:air|cave_air|void_air|structure_void|barrier|light_block(?:_\d+)?|moving_block|(?:sticky_)?piston_arm_collision|border_block|allow|deny|camera|invisible_bedrock|web|fire|soul_fire|frame|glow_frame|skull|chain|end_rod|lever|ladder|tripwire|trip_wire|tripwire_hook|bell|glow_lichen|sculk_vein|resin_clump|hanging_roots|spore_blossom|frog_spawn|pointed_dripstone|end_portal|end_gateway|portal|cave_vines(?:_body_with_berries|_head_with_berries)?|(?:weeping|twisting)_vines|vine|amethyst_cluster|(?:small|medium|large)_amethyst_bud|.*_(?:sign|hanging_sign|banner|button|head|skull|candle|wall_torch))$|^(?:standing_sign|wall_sign|standing_banner|wall_banner|candle)$/;

const PLANT_SPRITES = {
  grass: PlantSprite.Grass,
  crop: PlantSprite.Crop,
  stalk: PlantSprite.Stalk,
  mushroom: PlantSprite.Mushroom,
  bush: PlantSprite.Bush,
} as const;
const PLANTS = PLANT_COLOR_RULES.map(
  ([pattern, kind, color, tint]) => [pattern, PLANT_SPRITES[kind], color, tint] as const,
);

/** Simple boxes in sixteenths. Multipart models are resolved before these fallbacks. */
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
  [new RegExp(`_wall$|^(?:iron_|${COPPER_PREFIX})bars$`), box(16, 4), QuadMaterial.Solid],
  [
    new RegExp(`^(?:chest|trapped_chest|ender_chest|${COPPER_PREFIX}chest)$`),
    box(14, 1),
    QuadMaterial.Solid,
  ],
  [/^(?:bed|cake|candle_cake)$|_bed$/, box(9, 1), QuadMaterial.Solid],
  [new RegExp(`^(?:soul_|${COPPER_PREFIX})?lantern$`), box(9, 5), QuadMaterial.Emissive],
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

/**
 * Resolves the 3D look of a Bedrock block from its name and palette states.
 * Legacy names that keep their variant in a state are first mapped to modern names.
 */
export function resolveBlockAppearance(
  name: string,
  states: LittleEndianNbtCompoundValue,
): BlockAppearance {
  const block = canonicalBlockName(name, states);
  const shape = resolveShape(block, states);
  const style = defaultBlockStyle(`minecraft:${block}`);
  const kind =
    shape.kind === "water"
      ? "water"
      : shape.kind === "plant"
        ? shape.sprite === PlantSprite.Flower
          ? "flower"
          : "plant"
        : shape.kind === "cube" && shape.material === QuadMaterial.Foliage
          ? "foliage"
          : "block";
  return {
    shape,
    ...resolveAppearanceColors(name, states, kind, rgb(style.red, style.green, style.blue)),
  };
}

function resolveShape(block: string, states: LittleEndianNbtCompoundValue): BlockShape {
  const model = resolveBlockModel(block, states);
  if (model !== undefined) {
    const material = GLASS.test(block)
      ? QuadMaterial.Glass
      : model.family === "lantern" ||
          model.family === "rod" ||
          (model.family === "candle" && states.lit === 1)
        ? QuadMaterial.Emissive
        : QuadMaterial.Solid;
    return { kind: "model", model, material };
  }
  if (block === "lava" || block === "flowing_lava") {
    const level = typeof states.liquid_depth === "number" ? states.liquid_depth : 0;
    return { kind: "lava", level: Math.max(0, Math.min(15, level)) };
  }
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

function box(size: number, inset: number): QuadBox {
  return size === 16 && inset === 0 ? FULL_BOX : { size, inset, anchoredTop: false };
}

export { rgb };
