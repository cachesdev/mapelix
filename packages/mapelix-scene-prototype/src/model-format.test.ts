import { describe, expect, it } from "vitest";
import {
  Face,
  FULL_BOX,
  QUAD_LAVA_FLAG,
  QUAD_MODEL_FLAG,
  QuadMaterial,
  isLavaQuad,
  packModelWord1,
  packQuadWord0,
  partitionLavaQuads,
  unpackQuad,
} from "./format.js";

describe("quad extensions", () => {
  it("round-trips model boxes, one cell wide and high", () => {
    const boxes = [
      [0, 0, 0, 16, 16, 16],
      [0, 0, 0, 16, 16, 3],
      [7, 5, 14, 9, 16, 16],
      [3, 10, 3, 13, 16, 13],
    ] as const;
    for (const bounds of boxes) {
      const word0 = packQuadWord0(4, 60, 8, Face.PositiveY, QuadMaterial.Solid) | QUAD_MODEL_FLAG;
      const word1 = packModelWord1(bounds);
      const decoded = unpackQuad(Uint32Array.of(word0, word1, 0xffaabbcc), 0);
      expect(decoded.modelBounds).toEqual(bounds);
      expect(decoded.box).toEqual(FULL_BOX);
      expect(decoded.width).toBe(1);
      expect(decoded.height).toBe(1);
      expect((word0 >>> 26) & 15).toBe(QuadMaterial.Solid);
      expect(isLavaQuad(word0, word1)).toBe(false);
    }
    expect(() => packModelWord1([0, 0, 0, 17, 16, 16])).toThrow(RangeError);
  });
  it("reads pre-extension regions with their unchanged meaning", () => {
    // Literal legacy words: cube at (0, 0, 0), positive-Y face, size 16, RGB #d55b13.
    const old = Uint32Array.of(0x1100000, 0x000f0000, 0xffd55b13);
    const quad = unpackQuad(old, 0);
    expect(quad).not.toHaveProperty("modelBounds");
    expect(quad).not.toHaveProperty("lava");
    expect(quad.box).toEqual(FULL_BOX);
  });
  it("partitions lava in place without mistaking detail ids for lava or losing any quads", () => {
    const base = packQuadWord0(0, 60, 0, Face.PositiveY, QuadMaterial.Emissive);
    const words = Uint32Array.of(
      base,
      0xf0000 | QUAD_LAVA_FLAG,
      1,
      base | QUAD_MODEL_FLAG,
      packModelWord1([0, 0, 0, 16, 16, 3]),
      2,
      base,
      0xf0000,
      3,
    );
    const original = words.buffer;
    partitionLavaQuads(words);
    expect(words.buffer).toBe(original);
    expect([words[2]!, words[5]!].sort((a, b) => a - b)).toEqual([2, 3]);
    expect(words[8]).toBe(1);
    expect(isLavaQuad(words[6]!, words[7]!)).toBe(true);
  });
});
