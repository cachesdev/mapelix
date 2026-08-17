import { describe, expect, it } from "vitest";

import { defaultBlockStyle } from "./block-style.js";

describe("defaultBlockStyle", () => {
  it.each([
    ["minecraft:oak_fence", [178, 137, 76, 255]],
    ["minecraft:stripped_oak_wood", [178, 137, 76, 255]],
    ["minecraft:trapdoor", [191, 153, 63, 255]],
    ["minecraft:mossy_cobblestone", [127, 127, 127, 255]],
    ["minecraft:dirt", [142, 126, 61, 255]],
    ["minecraft:crafting_table", [216, 216, 216, 255]],
    ["minecraft:undyed_shulker_box", [216, 216, 216, 255]],
    ["minecraft:cherry_leaves", [245, 137, 191, 255]],
    ["minecraft:double_plant", [140, 214, 91, 255]],
    ["minecraft:brown_mushroom", [122, 104, 30, 255]],
    ["minecraft:seagrass", [105, 169, 8, 255]],
    ["minecraft:cornflower", [61, 171, 244, 255]],
    ["minecraft:acacia_slab", [158, 79, 45, 255]],
    ["minecraft:acacia_log", [158, 79, 45, 255]],
    ["minecraft:bamboo", [132, 163, 40, 255]],
    ["minecraft:bamboo_wall_sign", [153, 132, 50, 255]],
    ["minecraft:lightning_rod", [216, 38, 38, 255]],
    ["minecraft:weathered_lightning_rod", [89, 165, 108, 255]],
    ["minecraft:oxidized_lightning_rod", [82, 172, 139, 255]],
    ["minecraft:reeds", [132, 163, 40, 255]],
    ["minecraft:yellow_terracotta", [169, 154, 96, 255]],
    ["minecraft:lit_pumpkin", [255, 234, 50, 255]],
    ["minecraft:obsidian", [13, 9, 23, 255]],
    ["minecraft:redstone_wire", [216, 38, 38, 255]],
    ["minecraft:unpowered_repeater", [216, 38, 38, 255]],
    ["minecraft:powered_comparator", [216, 38, 38, 255]],
    ["minecraft:dispenser", [216, 38, 38, 255]],
    ["minecraft:lever", [216, 38, 38, 255]],
    ["minecraft:sticky_piston", [216, 38, 38, 255]],
    ["minecraft:stone", [127, 127, 127, 255]],
  ] as const)("matches the uNmINeD base color for %s", (name, expected) => {
    const actual = defaultBlockStyle(name);
    expect([actual.red, actual.green, actual.blue, actual.alpha]).toEqual(expected);
  });
});
