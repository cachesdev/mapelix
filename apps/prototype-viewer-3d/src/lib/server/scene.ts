import { resolve } from "node:path";
import { createSceneHandler, createSceneServer } from "@mapelix/viewer/node";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer, received ${raw}`);
  return value;
}

/** The local world, configured from the environment. */
export const scene = createSceneServer({
  worldDirectory:
    process.env.MAPELIX_WORLD_DIRECTORY ??
    resolve(process.cwd(), "../../.local/worlds/Amelix-8-12-26/Amelix SMP"),
  cacheDirectory: process.env.MAPELIX_CACHE_DIRECTORY ?? "/tmp/mapelix-scene-cache",
  workers: positive("MAPELIX_SCENE_WORKERS", 1),
  caveMemoryMiB: positive("MAPELIX_CAVE_MEMORY_MIB", 16),
  discoveryMemoryMiB: positive("MAPELIX_DISCOVERY_MEMORY_MIB", 4),
});

export const handleScene = createSceneHandler(scene);
