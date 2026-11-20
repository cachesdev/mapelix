import { describe, expect, it } from "vitest";
import {
  horizontalSelection,
  selectionAround,
  selectionContains,
  selectionFromSearch,
  selectionIntersects,
  selectedRayRange,
} from "./selection.js";
import { regionCacheKey, sceneContext } from "./dimensions.js";

describe("local exploration bounds", () => {
  const area = horizontalSelection({ minX: -32, maxX: 32, minZ: -16, maxZ: 16 });
  it("restores signed selections with exclusive edges without altering terrain identities", () => {
    expect(
      selectionFromSearch(
        new URLSearchParams({ minX: "-32", maxX: "32", minZ: "-16", maxZ: "16" }),
      ),
    ).toEqual(area);
    expect(selectionFromSearch(new URLSearchParams())).toBeUndefined();
    expect(selectionAround(0, 0)).toEqual({ minX: -32, maxX: 32, minZ: -32, maxZ: 32 });
    expect(selectionContains(area, -32, 0)).toBe(true);
    expect(selectionContains(area, 32, 0)).toBe(false);
    expect(selectionIntersects(area, 32, -16, 64)).toBe(false);
    const context = sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 });
    expect(regionCacheKey({ ...context, ...area }, { level: 0, x: -1, z: 0 })).toBe(
      "overworld/caves/-64/-32/0/-1/0",
    );
  });
  it("rejects partial, reversed, unbounded and non-integer areas", () => {
    for (const query of [
      "minX=0",
      "minX=0&maxX=512&minZ=0&maxZ=32",
      "minX=32&maxX=0&minZ=0&maxZ=32",
      "minX=&maxX=32&minZ=0&maxZ=32",
      "minX=0.5&maxX=32&minZ=0&maxZ=32",
    ])
      expect(() => selectionFromSearch(new URLSearchParams(query))).toThrow(RangeError);
  });
  it("clips collision rays entering from outside and excludes hidden terrain", () => {
    expect(selectedRayRange(area, { x: -64, z: 0 }, { x: 1, z: 0 }, 200)).toEqual([32, 96]);
    expect(selectedRayRange(area, { x: 0, z: 0 }, { x: 0, z: 1 }, 100)).toEqual([0, 16]);
    expect(selectedRayRange(area, { x: 32, z: 0 }, { x: 0, z: 1 }, 100)).toBeUndefined();
    expect(selectedRayRange(area, { x: -64, z: 0 }, { x: -1, z: 0 }, 100)).toBeUndefined();
  });
});
