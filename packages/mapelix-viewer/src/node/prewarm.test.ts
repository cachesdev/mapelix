import type { Dimension } from "@mapelix/scene-prototype";
import { describe, expect, it } from "vitest";

import { Prewarmer, prewarmPlan, type PrewarmTarget } from "./prewarm.js";
import { OverloadedError, emptyRegionBytes } from "./region-service.js";

const WORLD = new Map<
  Dimension,
  { minX: number; minZ: number; maxX: number; maxZ: number } | undefined
>([
  ["overworld", { minX: -100, minZ: -100, maxX: 100, maxZ: 100 }],
  ["nether", undefined],
]);

describe("prewarmPlan", () => {
  it("covers the stored area, coarse levels first, middle first", () => {
    const plan = prewarmPlan(WORLD, 1000);
    expect(plan[0]).toMatchObject({ level: 5, dimension: "overworld" });
    expect(plan.at(-1)?.level).toBe(0);
    const levels = plan.map((job) => job.level);
    expect([...levels].sort((left, right) => right - left)).toEqual(levels);
    // Level 0 regions are 64 blocks wide: x and z from -2 to 1.
    expect(plan.filter((job) => job.level === 0)).toHaveLength(16);
    expect(plan.every((job) => job.dimension === "overworld")).toBe(true);
  });

  it("finishes one dimension before the next", () => {
    const area = { minX: -10, minZ: -10, maxX: 10, maxZ: 10 };
    const plan = prewarmPlan(
      new Map<Dimension, typeof area | undefined>([
        ["overworld", area],
        ["nether", area],
      ]),
      1000,
    );
    const dimensions = plan.map((job) => job.dimension);
    expect(dimensions.indexOf("nether")).toBe(dimensions.lastIndexOf("overworld") + 1);
    expect(plan.find((job) => job.dimension === "nether")?.level).toBe(5);
    expect(plan.every((job) => job.ceilingY === undefined)).toBe(true);
  });

  it("keeps the coarse levels when capped", () => {
    const plan = prewarmPlan(WORLD, 5);
    expect(plan).toHaveLength(5);
    expect(plan[0]?.level).toBe(5);
  });
});

describe("Prewarmer", () => {
  it("builds every region once and reports what it built", async () => {
    const seen: string[] = [];
    const target: PrewarmTarget = {
      load: async (dimension, request) => {
        seen.push(`${dimension}/${request.level}/${request.x}/${request.z}`);
        const cached = request.level === 5;
        return {
          bytes: emptyRegionBytes(request.level, request.x, request.z),
          cacheStatus: cached ? "disk" : "build",
          milliseconds: 1,
        };
      },
    };
    const plan = prewarmPlan(WORLD, 1000);
    const prewarmer = new Prewarmer(target, plan, () => false);
    const result = await prewarmer.run(new AbortController().signal);
    expect(result.state).toBe("done");
    expect(result.done).toBe(plan.length);
    expect(result.built).toBe(plan.filter((job) => job.level !== 5).length);
    expect(new Set(seen).size).toBe(plan.length);
  });

  it("retries a region after an overloaded queue and stops when asked", async () => {
    let calls = 0;
    const target: PrewarmTarget = {
      load: async (_dimension, request) => {
        calls += 1;
        if (calls === 1) throw new OverloadedError("busy");
        return {
          bytes: emptyRegionBytes(request.level, request.x, request.z),
          cacheStatus: "build",
          milliseconds: 1,
        };
      },
    };
    const plan = prewarmPlan(WORLD, 3);
    const done = await new Prewarmer(target, plan, () => false).run(
      new AbortController().signal,
      1,
    );
    expect(done).toMatchObject({ state: "done", done: 3 });
    expect(calls).toBe(4);

    const controller = new AbortController();
    controller.abort();
    const stopped = await new Prewarmer(target, plan, () => false).run(controller.signal);
    expect(stopped).toMatchObject({ state: "stopped", reason: "shutdown", done: 0 });
  });

  it("stops before filling the disk cache", async () => {
    const target: PrewarmTarget = { load: () => Promise.reject(new Error("never called")) };
    const result = await new Prewarmer(target, prewarmPlan(WORLD, 10), () => true).run(
      new AbortController().signal,
    );
    expect(result).toMatchObject({ state: "stopped", reason: "cache-full" });
  });
});
