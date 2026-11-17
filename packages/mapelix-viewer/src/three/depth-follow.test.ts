import { describe, expect, it } from "vitest";
import { sceneContext, type SceneContext } from "@mapelix/scene-prototype/dimensions";
import { adjacentDepth, DepthFollow } from "./depth-follow";

const caves = (minY = -48, thickness = 32) =>
  sceneContext("overworld", { mode: "caves", minY, maxY: minY + thickness });
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("automatic cave depth", () => {
  it("uses overlapping canonical 32-block windows, exclusive tops and dimension limits", () => {
    expect(adjacentDepth(caves(), -22, 1)).toBeUndefined();
    expect(adjacentDepth(caves(), -21, 1)).toEqual(caves(-32));
    expect(adjacentDepth(caves(), -44, -1)).toEqual(caves(-64));
    expect(adjacentDepth(caves(-64), -64, -1)).toBeUndefined();
    expect(adjacentDepth(caves(288), 319, 1)).toBeUndefined();
    expect(adjacentDepth(sceneContext("nether", { mode: "caves" }), 0, -1)).toBeUndefined();
    expect(adjacentDepth(sceneContext(), 319, 1)).toBeUndefined();
  });

  it("crosses adjacent 16-block windows only at the last visible block", () => {
    expect(adjacentDepth(caves(-48, 16), -34, 1)).toBeUndefined();
    expect(adjacentDepth(caves(-48, 16), -33, 1)).toEqual(caves(-32, 16));
    expect(adjacentDepth(caves(-48, 16), -48, -1)).toEqual(caves(-64, 16));
  });

  it("debounces input, permits one load, waits for terrain and limits successive changes", async () => {
    const requests: { context: SceneContext; resolve: (world: SceneContext) => void }[] = [];
    const applied: SceneContext[] = [];
    const follow = new DepthFollow<SceneContext>(
      (context) =>
        new Promise((resolve) => {
          requests.push({ context, resolve });
        }),
      (world) => {
        applied.push(world);
      },
      true,
    );
    follow.update(caves(), -21, 1, true, 0);
    follow.update(caves(), -21, 1, true, 249);
    expect(requests).toHaveLength(0);
    follow.update(caves(), -21, 1, true, 250);
    for (let time = 251; time < 10_000; time += 10) follow.update(caves(), -17, 1, true, time);
    expect(requests).toHaveLength(1);
    expect(follow.state.loading).toBe(true);
    requests[0]!.resolve(caves(-32));
    await flush();
    expect(applied).toEqual([caves(-32)]);
    follow.update(caves(-32), -1, 1, false, 1000);
    follow.update(caves(-32), -1, 1, false, 2000);
    expect(requests).toHaveLength(1);
    follow.update(caves(-32), -1, 1, true, 2050);
    follow.update(caves(-32), -1, 1, true, 2249);
    expect(requests).toHaveLength(1);
    follow.update(caves(-32), -1, 1, true, 2300);
    expect(requests).toHaveLength(2);
    follow.cancel();
  });

  it("aborts stale metadata on view changes and disabled following, even if the host resolves late", async () => {
    let finish!: (world: SceneContext) => void;
    let signal!: AbortSignal;
    const applied: SceneContext[] = [];
    const follow = new DepthFollow<SceneContext>(
      (_, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      (world) => {
        applied.push(world);
      },
      true,
    );
    follow.update(caves(), -17, 1, true, 0);
    follow.update(caves(), -17, 1, true, 300);
    follow.setEnabled(false);
    expect(signal.aborted).toBe(true);
    finish(caves(-32));
    await flush();
    expect(applied).toEqual([]);
    expect(follow.state).toMatchObject({ autoDepth: false, loading: false });
  });

  it("retains manual navigation without a host loader and rejects mismatched replies", async () => {
    const manual = new DepthFollow(undefined, () => {}, true);
    expect(manual.state).toMatchObject({ available: false, autoDepth: false });
    const applied: SceneContext[] = [];
    const follow = new DepthFollow(
      async () => sceneContext("nether"),
      (world) => {
        applied.push(world);
      },
      true,
    );
    follow.update(caves(), -17, 1, true, 0);
    follow.update(caves(), -17, 1, true, 300);
    await flush();
    expect(applied).toEqual([]);
    expect(follow.state.error).toContain("different cave slice");
    expect(() => new DepthFollow(undefined, () => {}, false, 100)).toThrow(RangeError);
  });

  it("reports a synchronously throwing host loader without escaping into the render loop", async () => {
    const follow = new DepthFollow<SceneContext>(
      () => {
        throw new Error("Metadata unavailable");
      },
      () => {},
      true,
    );
    follow.update(caves(), -17, 1, true, 0);
    expect(() => follow.update(caves(), -17, 1, true, 300)).not.toThrow();
    await flush();
    expect(follow.state).toMatchObject({ loading: false, error: "Metadata unavailable" });
  });
});
