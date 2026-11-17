import type { BuiltRegion, Dimension, RegionRequest, SceneWorld } from "@mapelix/scene-prototype";
import { describe, expect, it, vi } from "vitest";

import { DimensionPools } from "./pools.js";

interface Opened {
  readonly dimension: Dimension;
  closed: boolean;
  readonly builds: { request: RegionRequest; finish(): void }[];
}

function fakeWorlds(): { open: (dimension: Dimension) => Promise<SceneWorld>; opened: Opened[] } {
  const opened: Opened[] = [];
  const open = async (dimension: Dimension): Promise<SceneWorld> => {
    const entry: Opened = { dimension, closed: false, builds: [] };
    opened.push(entry);
    return {
      info: {} as SceneWorld["info"],
      buildRegion: (request: RegionRequest) =>
        new Promise<BuiltRegion>((resolve) => {
          entry.builds.push({
            request,
            finish: () => resolve({ bytes: new Uint8Array(4), milliseconds: 1 } as BuiltRegion),
          });
        }),
      buildDiscoveries: (tile) =>
        new Promise<BuiltRegion>((resolve) => {
          entry.builds.push({
            request: { level: -1, x: tile.x, z: tile.z },
            finish: () => resolve({ bytes: new Uint8Array(4), milliseconds: 1 } as BuiltRegion),
          });
        }),
      close: async () => {
        entry.closed = true;
      },
    };
  };
  return { open, opened };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const signal = (): AbortSignal => new AbortController().signal;

describe("DimensionPools", () => {
  it("shares one build budget between dimensions", async () => {
    const worlds = fakeWorlds();
    const pools = new DimensionPools({ open: worlds.open, permits: 1, idleMilliseconds: 0 });
    const first = pools.build("overworld", { level: 0, x: 0, z: 0 }, signal());
    const second = pools.build("nether", { level: 0, x: 0, z: 0 }, signal());
    await flush();
    expect(worlds.opened.map((entry) => entry.dimension)).toEqual(["overworld"]);
    worlds.opened[0]!.builds[0]!.finish();
    await first;
    await flush();
    expect(worlds.opened.map((entry) => entry.dimension)).toEqual(["overworld", "nether"]);
    worlds.opened[1]!.builds[0]!.finish();
    await second;
    await pools.close();
    expect(worlds.opened.every((entry) => entry.closed)).toBe(true);
  });

  it("lets a visitor go before waiting background work", async () => {
    const worlds = fakeWorlds();
    const pools = new DimensionPools({ open: worlds.open, permits: 1, idleMilliseconds: 0 });
    const running = pools.build("overworld", { level: 0, x: 0, z: 0 }, signal(), true);
    const prewarm = pools.build("overworld", { level: 0, x: 1, z: 0 }, signal(), true);
    const visitor = pools.discoveries("overworld", { x: 5, z: 6 }, signal());
    await flush();
    const builds = worlds.opened[0]!.builds;
    expect(builds.map((build) => build.request.x)).toEqual([0]);
    builds[0]!.finish();
    await running;
    await flush();
    expect(builds.map((build) => build.request)).toEqual([
      { level: 0, x: 0, z: 0 },
      { level: -1, x: 5, z: 6 },
    ]);
    builds[1]!.finish();
    await visitor;
    await flush();
    expect(builds[2]!.request.x).toBe(1);
    builds[2]!.finish();
    await prewarm;
    await pools.close();
  });

  it("drops a waiting build when its caller leaves", async () => {
    const worlds = fakeWorlds();
    const pools = new DimensionPools({ open: worlds.open, permits: 1, idleMilliseconds: 0 });
    const running = pools.build("overworld", { level: 0, x: 0, z: 0 }, signal());
    const controller = new AbortController();
    const waiting = pools.build("overworld", { level: 0, x: 1, z: 0 }, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await flush();
    worlds.opened[0]!.builds[0]!.finish();
    await running;
    expect(worlds.opened[0]!.builds).toHaveLength(1);
    await pools.close();
  });

  it("closes an idle dimension a few seconds after another one opens", async () => {
    vi.useFakeTimers();
    try {
      const worlds = fakeWorlds();
      const pools = new DimensionPools({
        open: worlds.open,
        permits: 2,
        idleMilliseconds: 300_000,
      });
      const overworld = pools.build("overworld", { level: 0, x: 0, z: 0 }, signal());
      await vi.advanceTimersByTimeAsync(0);
      worlds.opened[0]!.builds[0]!.finish();
      await overworld;
      const nether = pools.build("nether", { level: 0, x: 0, z: 0 }, signal());
      await vi.advanceTimersByTimeAsync(4_999);
      expect(worlds.opened[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(worlds.opened[0]!.closed).toBe(true);
      expect(pools.openDimensions).toEqual(["nether"]);
      // The dimension still building is never closed.
      await vi.advanceTimersByTimeAsync(600_000);
      expect(worlds.opened[1]!.closed).toBe(false);
      worlds.opened[1]!.builds[0]!.finish();
      await nether;
      await pools.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an idle dimension and reopens it on demand", async () => {
    vi.useFakeTimers();
    try {
      const worlds = fakeWorlds();
      const pools = new DimensionPools({ open: worlds.open, permits: 2, idleMilliseconds: 1000 });
      const build = pools.build("nether", { level: 0, x: 0, z: 0 }, signal());
      await vi.advanceTimersByTimeAsync(0);
      worlds.opened[0]!.builds[0]!.finish();
      await build;
      expect(pools.openDimensions).toEqual(["nether"]);
      await vi.advanceTimersByTimeAsync(999);
      expect(worlds.opened[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(worlds.opened[0]!.closed).toBe(true);
      expect(pools.openDimensions).toEqual([]);
      const again = pools.build("nether", { level: 0, x: 0, z: 0 }, signal());
      await vi.advanceTimersByTimeAsync(0);
      expect(worlds.opened).toHaveLength(2);
      worlds.opened[1]!.builds[0]!.finish();
      await again;
      await pools.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
