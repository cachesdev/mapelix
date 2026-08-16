import { describe, expect, it } from "vitest";

import { floorDiv, tileBounds } from "./tile.js";

describe("tile coordinates", () => {
  it("maps negative XYZ tiles without folding them around zero", () => {
    expect(
      tileBounds({
        dimension: "overworld",
        z: 0,
        x: -1,
        y: 2,
      }),
    ).toEqual({ minX: -256, minZ: 512, maxX: 0, maxZ: 768 });
  });

  it("rejects zoom levels outside the prototype", () => {
    expect(() => tileBounds({ dimension: "overworld", z: 1, x: 0, y: 0 })).toThrow(
      "supports only zoom 0",
    );
  });
});

describe("floorDiv", () => {
  it.each([
    [31, 16, 1],
    [0, 16, 0],
    [-1, 16, -1],
    [-16, 16, -1],
    [-17, 16, -2],
  ])("floor divides %i by %i as %i", (value, divisor, expected) => {
    expect(floorDiv(value, divisor)).toBe(expected);
  });
});
