import { discoveryCacheKey, type DiscoveryRequest } from "@mapelix/scene-prototype/discoveries";
import type { Dimension } from "@mapelix/scene-prototype/dimensions";
import type { SceneWorld } from "@mapelix/scene-prototype";
import type { LoadedRegion } from "./scene-world.js";

export interface DiscoveryCacheOptions {
  readonly memoryMiB: number;
  readonly getSceneWorld: (dimension: Dimension) => Promise<Pick<SceneWorld, "buildDiscoveries">>;
  readonly getSnapshotRevision: () => Promise<string>;
}

/** Dedicated bounded partition; no disk writes, terrain eviction or window/filter variants. */
export function createDiscoveryCache({
  memoryMiB,
  getSceneWorld,
  getSnapshotRevision,
}: DiscoveryCacheOptions) {
  if (!Number.isSafeInteger(memoryMiB) || memoryMiB < 1)
    throw new RangeError("discoveryMemoryMiB must be a positive integer");
  const budget = memoryMiB * 1024 * 1024;
  const memory = new Map<string, LoadedRegion>();
  const pending = new Map<
    string,
    { controller: AbortController; promise: Promise<LoadedRegion>; users: number }
  >();
  let bytes = 0;

  return async function loadDiscoveries(
    dimension: Dimension,
    tile: DiscoveryRequest,
    signal: AbortSignal,
  ): Promise<LoadedRegion> {
    if (signal.aborted) throw new DOMException("Discovery request cancelled", "AbortError");
    const key = discoveryCacheKey(await getSnapshotRevision(), dimension, tile);
    const cached = memory.get(key);
    if (cached) {
      memory.delete(key);
      memory.set(key, cached);
      return { ...cached, cacheStatus: "memory" };
    }
    let shared = pending.get(key);
    if (shared?.controller.signal.aborted) {
      pending.delete(key);
      shared = undefined;
    }
    if (!shared) {
      const controller = new AbortController();
      const promise = getSceneWorld(dimension)
        .then((world) => world.buildDiscoveries(tile, controller.signal))
        .then((built): LoadedRegion => {
          const result: LoadedRegion = { ...built, cacheStatus: "build" };
          if (!controller.signal.aborted && built.bytes.byteLength <= budget) {
            memory.set(key, result);
            bytes += built.bytes.byteLength;
            while (bytes > budget || memory.size > 256) {
              const oldest = memory.keys().next().value!;
              bytes -= memory.get(oldest)!.bytes.byteLength;
              memory.delete(oldest);
            }
          }
          return result;
        })
        .finally(() => {
          if (pending.get(key)?.promise === promise) pending.delete(key);
        });
      shared = { controller, promise, users: 0 };
      pending.set(key, shared);
    }
    const task = shared;
    task.users++;
    return new Promise<LoadedRegion>((resolve, reject) => {
      let completed = false;
      const finish = (error?: unknown, result?: LoadedRegion) => {
        if (completed) return;
        completed = true;
        signal.removeEventListener("abort", abort);
        task.users--;
        if (!task.users) task.controller.abort();
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = () => finish(new DOMException("Discovery request cancelled", "AbortError"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void task.promise.then(
        (result) => finish(undefined, result),
        (error) => finish(error),
      );
    });
  };
}
