import { describe, expect, it } from "vitest";

import { canonicalBiomeId, legacyBiomeStyle } from "./biome-style.js";

describe("legacyBiomeStyle", () => {
  it("matches the published classic plains colors", () => {
    expect(legacyBiomeStyle(1)).toMatchObject({
      groundGrass: { red: 127, green: 166, blue: 78 },
      grass: { red: 127, green: 166, blue: 78 },
      foliage: { red: 67, green: 96, blue: 26 },
      water: { red: 25, green: 107, blue: 229 },
    });
  });

  it("matches the published classic swamp colors", () => {
    expect(legacyBiomeStyle(6)).toMatchObject({
      groundGrass: { red: 94, green: 99, blue: 53 },
      grass: { red: 100, green: 107, blue: 45 },
      foliage: { red: 60, green: 65, blue: 21 },
      water: { red: 75, green: 102, blue: 82 },
    });
  });

  it("uses ocean-family land tint for legacy rivers", () => {
    expect(legacyBiomeStyle(7)).toMatchObject({
      groundGrass: { red: 124, green: 162, blue: 99 },
      grass: { red: 124, green: 162, blue: 99 },
      foliage: { red: 63, green: 94, blue: 43 },
    });
  });

  it("uses plains-family land tint for legacy beaches", () => {
    expect(legacyBiomeStyle(16)).toMatchObject({
      groundGrass: { red: 127, green: 166, blue: 78 },
      grass: { red: 127, green: 166, blue: 78 },
      foliage: { red: 67, green: 96, blue: 26 },
    });
  });

  it.each([
    [0, [25, 86, 229]],
    [40, [25, 127, 229]],
    [42, [25, 117, 229]],
    [44, [8, 70, 215]],
  ] as const)("uses classic water family color for biome %i", (biomeId, expected) => {
    const water = legacyBiomeStyle(biomeId).water;
    expect([water.red, water.green, water.blue]).toEqual(expected);
  });

  it("keeps modern Data3D IDs distinct from legacy mutation aliases", () => {
    expect(canonicalBiomeId(157)).toBe(29);
    expect(canonicalBiomeId(190)).toBe(190);
    expect(canonicalBiomeId(192)).toBe(192);
    expect(legacyBiomeStyle(192)).toMatchObject({
      groundGrass: { red: 159, green: 192, blue: 85 },
      foliage: { red: 102, green: 123, blue: 54 },
      water: { red: 25, green: 107, blue: 229 },
    });
  });
});
