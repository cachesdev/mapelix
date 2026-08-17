import { describe, expect, it } from "vitest";

import { defaultBlockStyle } from "./block-style.js";

describe("defaultBlockStyle", () => {
  it.each([
    ["minecraft:oak_fence", [178, 137, 76, 255]],
    ["minecraft:mossy_cobblestone", [127, 127, 127, 255]],
    ["minecraft:dirt", [142, 126, 61, 255]],
    ["minecraft:crafting_table", [216, 216, 216, 255]],
    ["minecraft:undyed_shulker_box", [216, 216, 216, 255]],
    ["minecraft:cherry_leaves", [245, 137, 191, 255]],
  ] as const)("matches the uNmINeD base color for %s", (name, expected) => {
    const actual = defaultBlockStyle(name);
    expect([actual.red, actual.green, actual.blue, actual.alpha]).toEqual(expected);
  });
});
