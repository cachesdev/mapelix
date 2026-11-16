import { describe, expect, it } from "vitest";

import { normalizeBatch } from "./options.js";
import { planTiles, tilePath } from "./plan.js";

const base = { world: "world", output: "output" };

describe("bounded batch planning", () => {
  it("normalizes dimension aliases, ordering and exact included cuts", () => {
    const value = normalizeBatch({
      ...base,
      dimensions: ["end", "nether", "end"],
      zooms: [2, 0, 2],
    });
    expect(value.profiles.map((profile) => [profile.dimension, profile.topY])).toEqual([
      ["nether", 90],
      ["the-end", 255],
    ]);
    expect(value.zooms).toEqual([0, 2]);
    expect(value.limits.maxPending).toBe(value.limits.workers);
    expect(normalizeBatch({ ...base, dimensions: ["nether"], topY: 89 }).profiles[0]!.topY).toBe(
      89,
    );
  });

  it.each([
    { limits: { workers: 0 } },
    { limits: { workers: 17 } },
    { limits: { maxPending: 1025 } },
    { limits: { maxTiles: Infinity } },
    { limits: { maxOutputBytes: -1 } },
    { limits: { memoryBudgetMiB: NaN } },
    { limits: { timeoutMs: 2 ** 31 } },
    { dimensions: [] },
    { zooms: [] },
    { zooms: [-1] },
    { zooms: [4] },
    { biomeBlendRadius: 17 },
    { topY: 320 },
    { bounds: { minX: 0, minZ: 0, maxX: 0, maxZ: 1 } },
  ])("rejects invalid plans before I/O: %j", (value) => {
    expect(() => normalizeBatch({ ...base, ...value })).toThrow(RangeError);
  });

  it("counts sparse cells and negative coordinates without filling the gap", () => {
    const batch = normalizeBatch({
      ...base,
      dimensions: ["overworld"],
      zooms: [0, 1],
      limits: { maxTiles: 10 },
    });
    const tiles = planTiles(
      {
        getTileCoverage: () => [
          { x: -1, y: -2, subchunkCount: 1 },
          { x: 10000, y: 10000, subchunkCount: 1 },
        ],
      },
      batch,
    );
    expect(tiles).toHaveLength(10);
    expect(tiles.filter((tile) => tile.z === 1 && tile.x < 0)).toContainEqual({
      dimension: "overworld",
      z: 1,
      x: -1,
      y: -3,
    });
    expect(tilePath(tiles[0]!)).toBe("overworld/tiles/0/-1/-2.png");
  });

  it("clips whole tiles by exclusive block bounds before applying the tile limit", () => {
    const batch = normalizeBatch({
      ...base,
      dimensions: ["overworld"],
      zooms: [2],
      bounds: { minX: -64, minZ: -64, maxX: 0, maxZ: 0 },
      limits: { maxTiles: 1 },
    });
    expect(
      planTiles(
        {
          getTileCoverage: () => [
            { x: -1, y: -1, subchunkCount: 1 },
            { x: 0, y: 0, subchunkCount: 1 },
          ],
        },
        batch,
      ),
    ).toEqual([{ dimension: "overworld", z: 2, x: -1, y: -1 }]);
  });

  it("rejects a large estimate before creating its child jobs", () => {
    const batch = normalizeBatch({ ...base, dimensions: ["overworld"], limits: { maxTiles: 20 } });
    expect(() =>
      planTiles({ getTileCoverage: () => [{ x: 0, y: 0, subchunkCount: 1 }] }, batch),
    ).toThrow("Tile estimate exceeds maxTiles");
  });
});
