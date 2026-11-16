import { describe, expect, it } from "vitest";

import { normalizeBatch } from "./options.js";
import { createBatchPlan, tilePath } from "./plan.js";

const input = { world: "world", output: "output", dimensions: ["overworld"] as const };
const world = {
  getTileCoverage: () => [
    { x: -1, y: -1, subchunkCount: 1 },
    { x: -2, y: -2, subchunkCount: 1 },
    { x: -1, y: -1, subchunkCount: 1 },
    { x: 0, y: 0, subchunkCount: 1 },
    { x: 1, y: 0, subchunkCount: 1 },
    { x: 10000, y: 10000, subchunkCount: 1 },
  ],
};

describe("sparse overview dependency planning", () => {
  it("deduplicates negative parents and leaves gaps between explored islands", () => {
    const plan = createBatchPlan(world, normalizeBatch({ ...input, zooms: [-4, -1] }));
    expect(plan.tiles).toHaveLength(6);
    expect(plan.temporary).toHaveLength(5);
    expect(plan.overviewSources.get("overworld/tiles/-4/-1/-1.png")?.map(tilePath)).toEqual([
      "overworld/tiles/0/-2/-2.png",
      "overworld/tiles/0/-1/-1.png",
    ]);
    expect(plan.overviewSources.get("overworld/tiles/-1/0/0.png")).toHaveLength(2);
    expect(plan.tiles.some((tile) => tile.x === 20)).toBe(false);
  });

  it("reuses selected zoom-zero tiles instead of planning duplicate native renders", () => {
    const plan = createBatchPlan(world, normalizeBatch({ ...input, zooms: [-4, 0] }));
    expect(plan.tiles).toHaveLength(8);
    expect(plan.temporary).toEqual([]);
    expect(plan.overviewSources.size).toBe(3);
  });

  it("counts hidden sources against the same preflight limit", () => {
    expect(() =>
      createBatchPlan(
        world,
        normalizeBatch({ ...input, zooms: [-4, -1], limits: { maxTiles: 10 } }),
      ),
    ).toThrow("including overview sources exceeds maxTiles");
    expect(
      createBatchPlan(
        world,
        normalizeBatch({ ...input, zooms: [-4, -1], limits: { maxTiles: 11 } }),
      ).temporary,
    ).toHaveLength(5);
  });

  it("retains source cells outside a narrow bounds clip when their overview is selected", () => {
    const plan = createBatchPlan(
      world,
      normalizeBatch({ ...input, zooms: [-1, 0], bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 } }),
    );
    expect(plan.tiles.map(tilePath)).toEqual([
      "overworld/tiles/-1/0/0.png",
      "overworld/tiles/0/0/0.png",
    ]);
    expect(plan.temporary.map(tilePath)).toEqual(["overworld/tiles/0/1/0.png"]);
    expect(plan.overviewSources.get("overworld/tiles/-1/0/0.png")).toHaveLength(2);
  });

  it("keeps whole cells on an exclusive negative bound without leaking across zero", () => {
    const plan = createBatchPlan(
      world,
      normalizeBatch({ ...input, zooms: [-4], bounds: { minX: -1, minZ: -1, maxX: 0, maxZ: 0 } }),
    );
    expect(plan.tiles.map(tilePath)).toEqual(["overworld/tiles/-4/-1/-1.png"]);
    expect(plan.temporary.map(tilePath)).toEqual([
      "overworld/tiles/0/-2/-2.png",
      "overworld/tiles/0/-1/-1.png",
    ]);
  });

  it("uses -4..+2 by default and supports an explicit legacy +3 request", () => {
    expect(normalizeBatch(input).zooms).toEqual([-4, -3, -2, -1, 0, 1, 2]);
    expect(normalizeBatch({ ...input, zooms: [3] }).zooms).toEqual([3]);
  });
});
