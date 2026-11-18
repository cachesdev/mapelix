import { describe, expect, it } from "vitest";

import { BlockPalette, type PaletteTextures } from "./block-palette.js";
import { Face } from "../format.js";
import { unpackQuadTexture } from "../textures/atlas-format.js";
import type { BlockTextureNames } from "../textures/resource-pack.js";

const all = (name: string): BlockTextureNames => ({
  up: name,
  down: name,
  north: name,
  south: name,
  east: name,
  west: name,
});
const NAMES = ["stone", "lantern", "torch_on", "end_rod", "chain", "planks_oak", "lightning_rod"];
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
    lightning_rod: all("lightning_rod"),
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

  it("keeps the block color of a sheet of parts no shape matches", () => {
    expect(words("lightning_rod")).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("textures models drawn from a sheet of parts; their parts pick the rectangles", () => {
    for (const name of ["lantern", "soul_lantern", "end_rod", "iron_chain"])
      expect(
        words(name).every((word) => word !== 0),
        name,
      ).toBe(true);
  });

  it("moves a torch's top and bottom onto the stick of its sheet", () => {
    const torch = words("torch").map(unpackQuadTexture);
    // The stick is 2 texels wide from (7, 6); its top reads (7, 6), its bottom (7, 13).
    expect(torch[Face.PositiveY]?.offset).toEqual([0, 15]);
    expect(torch[Face.NegativeY]?.offset).toEqual([0, 6]);
    // The sides already read the stick where they stand.
    for (const face of [Face.PositiveX, Face.NegativeX, Face.PositiveZ, Face.NegativeZ])
      expect(torch[face]?.offset, `face ${face}`).toBeUndefined();
  });

  it("textures other models and cubes", () => {
    for (const name of ["stone", "oak_fence"])
      expect(
        words(name).every((word) => word !== 0),
        name,
      ).toBe(true);
  });
});
