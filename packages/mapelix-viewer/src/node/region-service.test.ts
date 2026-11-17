import type { Dimension, RegionRequest } from "@mapelix/scene-prototype";
import { decodeSceneRegion } from "@mapelix/scene-prototype/format";
import { describe, expect, it } from "vitest";

import {
  InvalidRegionError,
  NotCachedError,
  OverloadedError,
  RegionService,
  emptyRegionBytes,
  type BuildRegion,
  type RegionStore,
} from "./region-service.js";

const WORLD = { minX: -100, minZ: -100, maxX: 100, maxZ: 100 };

interface Deferred {
  readonly request: RegionRequest;
  readonly signal: AbortSignal;
  resolve(): void;
}

/** A builder whose builds finish only when the test says so. */
function controlledBuilder(): { build: BuildRegion; pending: Deferred[]; calls: number } {
  const state = { pending: [] as Deferred[], calls: 0, build: undefined as unknown as BuildRegion };
  state.build = (_dimension, request, signal) => {
    state.calls += 1;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")));
      state.pending.push({
        request,
        signal,
        resolve: () =>
          resolve({
            bytes: emptyRegionBytes(request.level, request.x, request.z),
            milliseconds: 1,
          }),
      });
    });
  };
  return state;
}

function memoryStore(): RegionStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    read: async (key) => files.get(key),
    write: async (key, bytes) => {
      files.set(key, bytes);
    },
    discard: async (key) => {
      files.delete(key);
    },
  };
}

function service(build: BuildRegion, store?: RegionStore, maxPending = 4): RegionService {
  return new RegionService({
    dimensions: new Map<Dimension, typeof WORLD | undefined>([
      ["overworld", WORLD],
      ["nether", undefined],
    ]),
    build,
    store,
    memoryBytes: 1024 * 1024,
    maxPending,
  });
}

const signal = (): AbortSignal => new AbortController().signal;
/** Lets the cache lookup that precedes every build finish. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("RegionService", () => {
  it("answers regions outside the world with an empty region and no build", async () => {
    const builder = controlledBuilder();
    const regions = service(builder.build);
    const result = await regions.load("overworld", { level: 0, x: 50, z: 50 }, signal());
    expect(result.cacheStatus).toBe("empty");
    expect(decodeSceneRegion(result.bytes)).toMatchObject({ level: 0, x: 50, z: 50 });
    expect(builder.calls).toBe(0);
    const nether = await regions.load("nether", { level: 2, x: 0, z: 0 }, signal());
    expect(nether.cacheStatus).toBe("empty");
  });

  it("rejects unserved dimensions, levels, and positions beyond the border", async () => {
    const regions = service(controlledBuilder().build);
    await expect(regions.load("the-end", { level: 0, x: 0, z: 0 }, signal())).rejects.toThrow(
      InvalidRegionError,
    );
    await expect(regions.load("overworld", { level: 6, x: 0, z: 0 }, signal())).rejects.toThrow(
      InvalidRegionError,
    );
    await expect(
      regions.load("overworld", { level: 0, x: 10_000_000, z: 0 }, signal()),
    ).rejects.toThrow(InvalidRegionError);
    await expect(regions.load("overworld", { level: 0, x: 0.5, z: 0 }, signal())).rejects.toThrow(
      InvalidRegionError,
    );
  });

  it("shares one build between identical requests and then serves memory", async () => {
    const builder = controlledBuilder();
    const regions = service(builder.build);
    const first = regions.load("overworld", { level: 0, x: 0, z: 0 }, signal());
    const second = regions.load("overworld", { level: 0, x: 0, z: 0 }, signal());
    await tick();
    expect(builder.calls).toBe(1);
    builder.pending[0]!.resolve();
    expect((await first).cacheStatus).toBe("build");
    expect((await second).cacheStatus).toBe("build");
    const third = await regions.load("overworld", { level: 0, x: 0, z: 0 }, signal());
    expect(third.cacheStatus).toBe("memory");
  });

  it("refuses new builds past the pending limit", async () => {
    const builder = controlledBuilder();
    const regions = service(builder.build, undefined, 2);
    const a = regions.load("overworld", { level: 0, x: 0, z: 0 }, signal());
    const b = regions.load("overworld", { level: 0, x: 1, z: 0 }, signal());
    await expect(regions.load("overworld", { level: 0, x: -1, z: 0 }, signal())).rejects.toThrow(
      OverloadedError,
    );
    expect(regions.stats.rejected).toBe(1);
    for (const deferred of builder.pending) deferred.resolve();
    await Promise.all([a, b]);
    const retried = regions.load("overworld", { level: 0, x: -1, z: 0 }, signal());
    await new Promise((resolve) => setTimeout(resolve, 0));
    builder.pending.at(-1)!.resolve();
    expect((await retried).cacheStatus).toBe("build");
  });

  it("cancels a queued build only when every caller has gone", async () => {
    const builder = controlledBuilder();
    const regions = service(builder.build);
    const one = new AbortController();
    const two = new AbortController();
    const first = regions.load("overworld", { level: 0, x: 0, z: 0 }, one.signal);
    const second = regions.load("overworld", { level: 0, x: 0, z: 0 }, two.signal);
    one.abort();
    await expect(first).rejects.toThrow(/cancelled/);
    expect(builder.pending[0]!.signal.aborted).toBe(false);
    two.abort();
    await expect(second).rejects.toThrow(/cancelled/);
    expect(builder.pending[0]!.signal.aborted).toBe(true);
    // A later caller starts a fresh build instead of joining the abandoned one.
    const later = regions.load("overworld", { level: 0, x: 0, z: 0 }, signal());
    await tick();
    expect(builder.calls).toBe(2);
    builder.pending[1]!.resolve();
    expect((await later).cacheStatus).toBe("build");
  });

  it("reads valid regions from the store and rebuilds corrupt ones", async () => {
    const builder = controlledBuilder();
    const store = memoryStore();
    store.files.set("overworld/320/0/1/1", emptyRegionBytes(0, 1, 1));
    store.files.set("overworld/320/0/-2/1", new Uint8Array([1, 2, 3, 4]));
    store.files.set("overworld/320/0/1/-2", emptyRegionBytes(0, 9, 9)); // Wrong region inside.
    const regions = service(builder.build, store);
    expect((await regions.load("overworld", { level: 0, x: 1, z: 1 }, signal())).cacheStatus).toBe(
      "disk",
    );
    for (const [x, z] of [
      [-2, 1],
      [1, -2],
    ] as const) {
      const pending = regions.load("overworld", { level: 0, x, z }, signal());
      await new Promise((resolve) => setTimeout(resolve, 0));
      builder.pending.at(-1)!.resolve();
      expect((await pending).cacheStatus).toBe("build");
      expect(decodeSceneRegion(store.files.get(`overworld/320/0/${x}/${z}`)!)).toMatchObject({
        x,
        z,
      });
    }
  });

  it("answers cache-only requests without ever building", async () => {
    const builder = controlledBuilder();
    const store = memoryStore();
    store.files.set("overworld/320/0/1/1", emptyRegionBytes(0, 1, 1));
    const regions = service(builder.build, store);
    const options = { cacheOnly: true };
    expect(
      (await regions.load("overworld", { level: 0, x: 1, z: 1 }, signal(), options)).cacheStatus,
    ).toBe("disk");
    await expect(
      regions.load("overworld", { level: 0, x: 0, z: 0 }, signal(), options),
    ).rejects.toThrow(NotCachedError);
    // Out of the world: still the free empty region.
    expect(
      (await regions.load("overworld", { level: 0, x: 90, z: 90 }, signal(), options)).cacheStatus,
    ).toBe("empty");
    expect(builder.calls).toBe(0);
  });

  it("keys every cache layer by ceiling and builds with the resolved ceiling", async () => {
    const builder = controlledBuilder();
    const store = memoryStore();
    const regions = new RegionService({
      dimensions: new Map<Dimension, typeof WORLD | undefined>([["nether", WORLD]]),
      build: builder.build,
      store,
      memoryBytes: 1024 * 1024,
      maxPending: 4,
    });
    const roofless = regions.load("nether", { level: 0, x: 0, z: 0 }, signal());
    const roofed = regions.load("nether", { level: 0, x: 0, z: 0, ceilingY: 128 }, signal());
    await tick();
    expect(builder.calls).toBe(2);
    expect(
      builder.pending.map((entry) => entry.request.ceilingY).sort((a, b) => (a ?? 0) - (b ?? 0)),
    ).toEqual([96, 128]);
    for (const entry of builder.pending) entry.resolve();
    await Promise.all([roofless, roofed]);
    expect([...store.files.keys()].sort()).toEqual(["nether/128/0/0/0", "nether/96/0/0/0"]);
    // The explicit default ceiling is the same region as no ceiling at all.
    const again = await regions.load("nether", { level: 0, x: 0, z: 0, ceilingY: 96 }, signal());
    expect(again.cacheStatus).toBe("memory");
    expect(builder.calls).toBe(2);
  });

  it("refuses ceilings the engine does not accept", async () => {
    const regions = service(controlledBuilder().build);
    for (const ceilingY of [100, -64, 336, 8]) {
      await expect(
        regions.load("overworld", { level: 0, x: 0, z: 0, ceilingY }, signal()),
      ).rejects.toBeInstanceOf(InvalidRegionError);
    }
  });

  it("keeps memory under its byte budget", async () => {
    const builder = controlledBuilder();
    const regions = new RegionService({
      dimensions: new Map([["overworld", WORLD]]),
      build: builder.build,
      store: undefined,
      memoryBytes: 20_000,
      maxPending: 8,
    });
    for (let x = -2; x < 2; x += 1) {
      const pending = regions.load("overworld", { level: 0, x, z: 0 }, signal());
      await tick();
      builder.pending.at(-1)!.resolve();
      await pending;
    }
    // Each empty level 0 region holds 8,232 bytes, so only two fit.
    expect(regions.stats.memoryEntries).toBe(2);
    expect(regions.stats.memoryBytes).toBeLessThanOrEqual(20_000);
  });
});
