import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDiscoveryCache } from "./discoveries";

const mocks = { build: vi.fn(), revision: "snapshot-a" };
const cache = (memoryMiB = 4) =>
  createDiscoveryCache({
    memoryMiB,
    getSnapshotRevision: async () => mocks.revision,
    getSceneWorld: async () => ({ buildDiscoveries: mocks.build }),
  });

beforeEach(() => {
  mocks.revision = "snapshot-a";
  mocks.build.mockReset();
});

describe("independent discovery cache", () => {
  it("reuses source indexes, evicts by bytes and separates snapshots and dimensions", async () => {
    mocks.build.mockImplementation(async () => ({
      bytes: new Uint8Array(600 * 1024),
      milliseconds: 1,
    }));
    const loadDiscoveries = cache(1);
    const signal = new AbortController().signal;
    await loadDiscoveries("overworld", { x: 0, z: 0 }, signal);
    expect((await loadDiscoveries("overworld", { x: 0, z: 0 }, signal)).cacheStatus).toBe("memory");
    await loadDiscoveries("overworld", { x: 1, z: 0 }, signal);
    expect((await loadDiscoveries("overworld", { x: 0, z: 0 }, signal)).cacheStatus).toBe("build");
    await loadDiscoveries("nether", { x: 0, z: 0 }, signal);
    mocks.revision = "snapshot-b";
    expect((await loadDiscoveries("nether", { x: 0, z: 0 }, signal)).cacheStatus).toBe("build");
    expect(mocks.build).toHaveBeenCalledTimes(5);
  });
  it("does not cancel a coalesced build when one of its visitors leaves", async () => {
    let finish: ((value: { bytes: Uint8Array; milliseconds: number }) => void) | undefined;
    mocks.build.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const loadDiscoveries = cache();
    const a = new AbortController(),
      b = new AbortController();
    const first = loadDiscoveries("overworld", { x: 0, z: 0 }, a.signal);
    const second = loadDiscoveries("overworld", { x: 0, z: 0 }, b.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledTimes(1));
    a.abort();
    await rejected;
    expect((mocks.build.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
    finish!({ bytes: new Uint8Array(32), milliseconds: 1 });
    expect((await second).cacheStatus).toBe("build");
  });
  it("cancels queued index work when every subscriber leaves", async () => {
    mocks.build.mockImplementation(
      (_tile, signal: AbortSignal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          ),
        ),
    );
    const loadDiscoveries = cache();
    const controller = new AbortController();
    const result = loadDiscoveries("overworld", { x: 0, z: 0 }, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.build).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect((mocks.build.mock.calls[0]![1] as AbortSignal).aborted).toBe(true);
  });
});
