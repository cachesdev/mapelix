import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSceneHandler, createSceneServer } from "@mapelix/viewer/node";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer, received ${raw}`);
  return value;
}

const directory = process.env.MAPELIX_WORLD_DIRECTORY;

/** True when a world folder is configured: the map then turns into the 3D world when zoomed in. */
export const hasWorld = directory !== undefined && directory !== "";
const worldDirectory = directory ?? "";

/** Serves the 3D endpoints of `MAPELIX_WORLD_DIRECTORY` below `/world` (the world is only read). */
export const handleWorld = hasWorld
  ? createSceneHandler(
      createSceneServer({
        worldDirectory,
        cacheDirectory:
          process.env.MAPELIX_CACHE_DIRECTORY ?? join(tmpdir(), "mapelix-demo-scene-cache"),
        workers: positive("MAPELIX_SCENE_WORKERS", 1),
        caveMemoryMiB: positive("MAPELIX_CAVE_MEMORY_MIB", 16),
        discoveryMemoryMiB: positive("MAPELIX_DISCOVERY_MEMORY_MIB", 4),
      }),
      "/world",
    )
  : undefined;
