import { expect, it } from "vitest";
import { blockEmission } from "./block-light.js";
import { BlockPalette } from "../mesh/block-palette.js";

it.each([
  ["torch", {}, 14],
  ["lantern", {}, 15],
  ["soul_lantern", {}, 10],
  ["redstone_torch", {}, 7],
  ["unlit_redstone_torch", {}, 0],
  ["lava", {}, 15],
  ["magma", {}, 3],
  ["portal", { portal_axis: "z" }, 11],
  ["nether_portal", { portal_axis: "x" }, 11],
  ["lightning_rod", {}, 0],
  ["campfire", { extinguished: 1 }, 0],
  ["soul_campfire", { extinguished: 0 }, 10],
  ["candle", { candles: 3, lit: 1 }, 12],
  ["red_candle", { candles: 2, lit: 0 }, 0],
  ["respawn_anchor", { respawn_anchor_charge: 0 }, 0],
  ["respawn_anchor", { respawn_anchor_charge: 4 }, 15],
  ["light_block", { block_light_level: 9 }, 9],
  ["waxed_weathered_copper_bulb", { lit: 1 }, 8],
  ["oxidized_copper_lantern", {}, 15],
  ["stone", {}, 0],
] as const)("resolves %s emission with its saved state", (name, states, light) => {
  expect(blockEmission(`minecraft:${name}`, states)).toBe(light);
});

it("keeps lighting states distinct in both palette modes, including boolean states", () => {
  for (const textures of [
    undefined,
    { fingerprint: "empty", blocks: {}, tiles: {}, terrain: {} },
  ]) {
    const palette = new BlockPalette(textures);
    const off = palette.idFor("minecraft:candle", { lit: 0, candles: 0 });
    const on = palette.idFor("minecraft:candle", { lit: 1, candles: 0 });
    const four = palette.idFor("minecraft:candle", { lit: 1, candles: 3 });
    const bool = palette.idFor("minecraft:campfire", { extinguished: true });
    const burning = palette.idFor("minecraft:campfire", { extinguished: false });
    expect(new Set([off, on, four]).size).toBe(3);
    expect([off, on, four, bool, burning].map((id) => palette.emission[id])).toEqual([
      0, 3, 12, 0, 15,
    ]);
  }
});
