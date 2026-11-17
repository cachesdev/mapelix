import { describe, expect, it } from "vitest";

import { BlockPalette, type PaletteTextures } from "./block-palette.js";
import type { BlockTextureNames } from "../textures/resource-pack.js";

const all = (name: string): BlockTextureNames => ({
  up: name,
  down: name,
  north: name,
  south: name,
  east: name,
  west: name,
});
const NAMES = ["stone", "lantern", "torch_on", "end_rod", "chain", "planks_oak"];
const index: PaletteTextures = {
  fingerprint: "palette-sprite-sheets",
  tiles: Object.fromEntries(NAMES.map((name, tile) => [`textures/blocks/${name}`, tile])),
  blocks: {
    stone: all("stone"),
    lantern: all("lantern"),
    soul_lantern: all("lantern"),
    torch: all("torch_on"),
    end_rod: all("end_rod"),
    iron_chain: all("chain"),
    oak_fence: all("planks_oak"),
  },
  terrain: Object.fromEntries(
    NAMES.map((name) => [name, { textures: [{ path: `textures/blocks/${name}` }] }]),
  ),
};

describe("block palette textures", () => {
  const palette = new BlockPalette(index);
  const words = (name: string): number[] => {
    const id = palette.idFor(`minecraft:${name}`, {});
    return [...palette.textureWords.slice(id * 6, id * 6 + 6)];
  };

  it("keeps the block color of blocks whose texture is a sheet of parts", () => {
    for (const name of ["lantern", "soul_lantern", "torch", "end_rod", "iron_chain"])
      expect(words(name), name).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("textures other models and cubes", () => {
    for (const name of ["stone", "oak_fence"])
      expect(
        words(name).every((word) => word !== 0),
        name,
      ).toBe(true);
  });
});
