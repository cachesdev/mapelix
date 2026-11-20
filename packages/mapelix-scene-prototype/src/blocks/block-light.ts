import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";

/** State keys that change vanilla block emission, independently of appearance. */
export const LIGHT_STATES = [
  "lit",
  "extinguished",
  "candles",
  "respawn_anchor_charge",
  "block_light_level",
  "cluster_count",
  "dead_bit",
  "toggle_bit",
] as const;

const EMISSION: Readonly<Record<string, number>> = {
  torch: 14,
  underwater_torch: 14,
  copper_torch: 14,
  soul_torch: 10,
  redstone_torch: 7,
  lantern: 15,
  soul_lantern: 10,
  glowstone: 15,
  sea_lantern: 15,
  shroomlight: 15,
  ochre_froglight: 15,
  verdant_froglight: 15,
  pearlescent_froglight: 15,
  lit_pumpkin: 15,
  jack_o_lantern: 15,
  lit_redstone_lamp: 15,
  lava: 15,
  flowing_lava: 15,
  magma: 3,
  end_rod: 14,
  crying_obsidian: 10,
  glow_lichen: 7,
  fire: 15,
  soul_fire: 10,
  portal: 11,
  nether_portal: 11,
  end_portal: 15,
  end_gateway: 15,
  beacon: 15,
  conduit: 15,
  lit_furnace: 13,
  lit_smoker: 13,
  lit_blast_furnace: 13,
  lit_redstone_ore: 9,
  redstone_ore_lit: 9,
  powered_repeater: 9,
  powered_comparator: 9,
  brewing_stand: 1,
  brown_mushroom: 1,
  dragon_egg: 1,
  enchanting_table: 7,
  end_portal_frame: 1,
  amethyst_cluster: 5,
  large_amethyst_bud: 4,
  medium_amethyst_bud: 2,
  small_amethyst_bud: 1,
  cave_vines_body_with_berries: 14,
  cave_vines_head_with_berries: 14,
  firefly_bush: 2,
};

const set = (value: unknown) => value === 1 || value === true;
const number = (states: LittleEndianNbtCompoundValue, key: string) =>
  typeof states[key] === "number" ? states[key] : 0;

/** Vanilla light levels, 0 through 15. Unknown/custom blocks emit no light. */
export function blockEmission(name: string, states: LittleEndianNbtCompoundValue): number {
  const block = name.replace(/^minecraft:/, "");
  if (block === "campfire" || block === "soul_campfire")
    return set(states.extinguished) ? 0 : block === "soul_campfire" ? 10 : 15;
  if (/(?:^|_)candle(?:_cake)?$/.test(block))
    return set(states.lit) ? 3 * Math.min(4, Math.max(1, number(states, "candles") + 1)) : 0;
  if (block === "respawn_anchor")
    return [0, 3, 7, 11, 15][Math.min(4, Math.max(0, number(states, "respawn_anchor_charge")))]!;
  if (block === "light_block")
    return Math.min(15, Math.max(0, number(states, "block_light_level")));
  if (block === "sea_pickle")
    return set(states.dead_bit)
      ? 0
      : 3 + 3 * Math.min(4, Math.max(1, number(states, "cluster_count") + 1));
  if (/(?:^|_)copper_lantern$/.test(block)) return 15;
  if (/(?:^|_)copper_bulb$/.test(block)) {
    if (!set(states.lit)) return 0;
    return block.includes("oxidized")
      ? 4
      : block.includes("weathered")
        ? 8
        : block.includes("exposed")
          ? 12
          : 15;
  }
  if (block === "redstone_lamp") return set(states.lit) ? 15 : 0;
  return EMISSION[block] ?? 0;
}
