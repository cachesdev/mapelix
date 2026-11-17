import { describe, expect, it, vi } from "vitest";
import {
  FULL_BOX,
  decodeSceneRegion,
  encodeSceneRegion,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
} from "@mapelix/scene-prototype/format";
import { exteriorBlock } from "./surface-visibility";
import { QuadCollider } from "./quad-collider";

describe("exact exterior visibility", () => {
  it("rejects unknown columns and blocks above a clipped window", () => {
    expect(
      exteriorBlock(
        4,
        70,
        6,
        () => undefined,
        () => true,
      ),
    ).toBe(false);
    expect(
      exteriorBlock(
        4,
        70,
        6,
        () => 64,
        () => true,
      ),
    ).toBe(false);
  });
  it("accepts a topmost block without an arbitrary burial margin", () => {
    expect(
      exteriorBlock(
        4,
        70,
        6,
        () => 71,
        () => false,
      ),
    ).toBe(true);
    expect(
      exteriorBlock(
        4,
        70,
        6,
        () => 72,
        () => false,
      ),
    ).toBe(false);
    expect(
      exteriorBlock(
        4,
        70,
        6,
        () => 79,
        () => true,
      ),
    ).toBe(false);
  });
  it("keeps a cliff face only beside a known sky-open column and an actual owned face", () => {
    const height = (x: number) => (x === 5 ? 65 : 81);
    const face = vi.fn(() => true);
    expect(exteriorBlock(4, 70, 6, height, face)).toBe(true);
    expect(face).toHaveBeenCalledWith(4, 70, 6, 0, 1);
    expect(exteriorBlock(4, 70, 6, height, () => false)).toBe(false);
    expect(
      exteriorBlock(
        4,
        70,
        6,
        (x) => (x === 5 ? undefined : 81),
        () => true,
      ),
    ).toBe(false);
  });
  it("does not treat an exposed cave under a roof as exterior", () => {
    expect(
      exteriorBlock(
        4,
        74,
        6,
        () => 81,
        () => true,
      ),
    ).toBe(false);
  });
  it("queries ownership of merged faces without mistaking the neighboring block", () => {
    const collider = new QuadCollider(
      decodeSceneRegion(
        encodeSceneRegion({
          level: 0,
          x: 0,
          z: 0,
          minY: 70,
          maxY: 81,
          heights: new Int16Array(64 * 64).fill(81),
          opaque: Uint32Array.of(
            packQuadWord0(4, 70, 6, 0, 0),
            packQuadWord1(3, 4, FULL_BOX, 0),
            packQuadWord2(0xffffff, 255),
          ),
          plants: new Uint32Array(),
          translucent: new Uint32Array(),
        }),
      ),
    );
    expect(collider.hasBlockFace(4, 72, 8, 0, 1)).toBe(true);
    expect(collider.hasBlockFace(4, 72, 8)).toBe(true);
    expect(collider.hasBlockFace(5, 72, 8)).toBe(false);
    expect(collider.hasBlockFace(5, 72, 8, 0, -1)).toBe(false);
    expect(collider.hasBlockFace(4, 74, 8, 0, 1)).toBe(false);
    expect(collider.hasBlockFace(3, 72, 8, 0, 1)).toBe(false);
  });
});
