import { describe, expect, it } from "vitest";
import {
  DIMENSIONS,
  contextFromSearch,
  contextSearch,
  parseDimension,
  regionCacheKey,
  sceneContext,
} from "./dimensions.js";

describe("dimension profiles and scene contexts", () => {
  it("uses Bedrock storage IDs and exclusive vanilla bounds", () => {
    expect(
      Object.values(DIMENSIONS).map(({ storageId, minY, maxY }) => [storageId, minY, maxY]),
    ).toEqual([
      [0, -64, 320],
      [1, 0, 128],
      [2, 0, 256],
    ]);
    expect(parseDimension(undefined)).toBe("overworld");
    expect(() => parseDimension("__proto__")).toThrow("Unsupported dimension");
  });

  it("separates identical region coordinates by dimension and ceiling", () => {
    const region = { level: 0, x: -1, z: 2 };
    const keys = [
      sceneContext(),
      sceneContext("nether"),
      sceneContext("the-end"),
      sceneContext("nether", 128),
    ].map((context) => regionCacheKey(context, region));
    expect(new Set(keys).size).toBe(4);
    expect(keys[1]).toBe("nether/96/0/-1/2");
  });

  it("round trips shareable context and rejects unsupported dimensions and cut bounds", () => {
    const context = sceneContext("nether", 80);
    expect(contextFromSearch(contextSearch(context))).toEqual(context);
    expect(contextFromSearch(new URLSearchParams())).toEqual(sceneContext());
    for (const ceiling of [0, 1, 95, 144, NaN, Infinity])
      expect(() => sceneContext("nether", ceiling)).toThrow(RangeError);
    expect(() => contextFromSearch(new URLSearchParams("dimension=moon"))).toThrow(RangeError);
  });
});
