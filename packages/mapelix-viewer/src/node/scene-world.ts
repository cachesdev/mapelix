import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { openSceneWorld, type RegionRequest, type SceneWorld } from "@mapelix/scene-prototype";
import { REGION_FORMAT_VERSION } from "@mapelix/scene-prototype/format";
import { DISCOVERY_LIMITS } from "@mapelix/scene-prototype/discoveries";
import {
  DIMENSIONS,
  CAVE_LIMITS,
  regionCacheKey,
  sceneContext,
  type Dimension,
  type DimensionConfig,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";
import { createDiscoveryCache } from "./discoveries.js";

/** Bump when mesh output changes without a format change, so stale disk caches are ignored. */
const meshRevision = 23;
const maxMemoryRegions = 384;

export interface SceneServerOptions {
  /** A Bedrock world folder (with `db`); opened read-only. */
  readonly worldDirectory: string;
  /** Folder for built Surface regions, keyed by world revision. */
  readonly cacheDirectory: string;
  /** Region builder worker threads per dimension (default 1). */
  readonly workers?: number;
  /** Memory for cave slices, which are never written to disk (default 16 MiB). */
  readonly caveMemoryMiB?: number;
  /** Memory for discovery indexes (default 4 MiB). */
  readonly discoveryMemoryMiB?: number;
}

export type CacheStatus = "memory" | "disk" | "build";

export interface LoadedRegion {
  readonly bytes: Uint8Array;
  readonly cacheStatus: CacheStatus;
  readonly milliseconds: number;
}

export interface WorldMetadata extends SceneContext {
  readonly dimension: Dimension;
  readonly ceilingY: number;
  readonly dimensions: readonly DimensionConfig[];
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  /** Changes whenever the world files or the mesh output change. */
  readonly revision: string;
  readonly caves: typeof CAVE_LIMITS;
  readonly snapshotRevision: string;
  readonly discoveries: typeof DISCOVERY_LIMITS;
}

/** Region, metadata and discovery loading for one world, with bounded caches. */
export type SceneServer = ReturnType<typeof createSceneServer>;

export function createSceneServer(options: SceneServerOptions) {
  const worldDirectory = resolve(options.worldDirectory);
  const cacheDirectory = resolve(options.cacheDirectory);
  const workers = positiveInteger(options.workers ?? 1, "workers");
  const caveMemoryBudget =
    positiveInteger(options.caveMemoryMiB ?? 16, "caveMemoryMiB") * 1024 * 1024;
  const worlds = new Map<Dimension, Promise<SceneWorld>>();
  let fingerprintPromise: Promise<{ terrain: string; snapshot: string }> | undefined;
  const memory = new Map<string, Promise<LoadedRegion>>();
  // Local caves are memory-only: exploring depths cannot create unbounded disk variants.
  // Production disk quotas and revision cleanup belong to the production server.
  const caveMemory = new Map<string, LoadedRegion>();
  const cavePending = new Map<string, Promise<LoadedRegion>>();
  let caveBytes = 0;

  function getSceneWorld(dimension: Dimension = "overworld"): Promise<SceneWorld> {
    let pending = worlds.get(dimension);
    if (pending === undefined) {
      pending = openSceneWorld({ directory: worldDirectory, dimension, workers });
      worlds.set(dimension, pending);
      void pending.catch(() => worlds.delete(dimension));
    }
    return pending;
  }

  async function getWorldMetadata(
    input: SceneContextInput = sceneContext(),
  ): Promise<WorldMetadata> {
    const context = sceneContext(input.dimension, input);
    const [world, revision] = await Promise.all([getSceneWorld(context.dimension), getRevision()]);
    const spawn =
      context.dimension === "overworld"
        ? world.info.spawn
        : context.dimension === "nether"
          ? { x: Math.floor(world.info.spawn.x / 8), y: 64, z: Math.floor(world.info.spawn.z / 8) }
          : { x: 100, y: 64, z: 0 };
    return {
      name: world.info.name,
      spawn: context.mode === "caves" ? { ...spawn, y: (context.minY + context.maxY) / 2 } : spawn,
      revision,
      ...context,
      dimensions: Object.values(DIMENSIONS),
      caves: CAVE_LIMITS,
      snapshotRevision: await getSnapshotRevision(),
      discoveries: DISCOVERY_LIMITS,
    };
  }

  /**
   * Returns a serialized region from memory, the disk cache, or a fresh build.
   * A cancelled request stops a queued build, but never a build already running.
   */
  function loadRegion(
    request: RegionRequest,
    signal: AbortSignal,
    input: SceneContextInput = sceneContext("overworld", request),
  ): Promise<LoadedRegion> {
    const context = sceneContext(input.dimension, input);
    const key = regionCacheKey(context, request);
    if (context.mode === "caves") {
      if (
        !Number.isInteger(request.level) ||
        request.level < 0 ||
        request.level > CAVE_LIMITS.maxLevel
      ) {
        throw new RangeError(`Caves support LOD 0 through ${CAVE_LIMITS.maxLevel}`);
      }
      const cached = caveMemory.get(key);
      if (cached !== undefined) {
        caveMemory.delete(key);
        caveMemory.set(key, cached);
        return Promise.resolve({ ...cached, cacheStatus: "memory" });
      }
      const active = cavePending.get(key);
      if (active !== undefined) return active;
      const pending = getSceneWorld(context.dimension)
        .then((world) => world.buildRegion({ ...request, ...context }, signal))
        .then((built) => {
          const region: LoadedRegion = { ...built, cacheStatus: "build" };
          if (region.bytes.byteLength <= caveMemoryBudget) {
            caveMemory.set(key, region);
            caveBytes += region.bytes.byteLength;
            while (caveBytes > caveMemoryBudget) {
              const oldest = caveMemory.keys().next().value!;
              caveBytes -= caveMemory.get(oldest)!.bytes.byteLength;
              caveMemory.delete(oldest);
            }
          }
          return region;
        })
        .finally(() => cavePending.delete(key));
      cavePending.set(key, pending);
      return pending;
    }
    const cached = memory.get(key);
    if (cached !== undefined) {
      memory.delete(key);
      memory.set(key, cached);
      return cached.then((region) => ({ ...region, cacheStatus: "memory" }));
    }

    const pending = readOrBuild(
      { ...request, ceilingY: context.ceilingY },
      key,
      signal,
      context.dimension,
    );
    memory.set(key, pending);
    void pending.catch(() => {
      if (memory.get(key) === pending) memory.delete(key);
    });
    while (memory.size > maxMemoryRegions) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
    return pending;
  }

  async function readOrBuild(
    request: RegionRequest,
    key: string,
    signal: AbortSignal,
    dimension: Dimension,
  ): Promise<LoadedRegion> {
    const startedAt = performance.now();
    const path = join(cacheDirectory, await getRevision(), `${key}.bin`);
    const stored = await readFile(path).catch(() => undefined);
    if (stored !== undefined) {
      return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
    }

    const world = await getSceneWorld(dimension);
    const built = await world.buildRegion(request, signal);
    await writeAtomically(path, built.bytes);
    return { bytes: built.bytes, cacheStatus: "build", milliseconds: built.milliseconds };
  }

  async function getRevision(): Promise<string> {
    fingerprintPromise ??= fingerprintWorld();
    return (await fingerprintPromise).terrain;
  }

  async function getSnapshotRevision(): Promise<string> {
    fingerprintPromise ??= fingerprintWorld();
    return (await fingerprintPromise).snapshot;
  }

  /** Hashes table names, sizes, and modification times. Reading the tables is not needed. */
  async function fingerprintWorld(): Promise<{ terrain: string; snapshot: string }> {
    const hash = createHash("sha256");
    const snapshot = createHash("sha256");
    hash.update(`scene-v${REGION_FORMAT_VERSION}-mesh-v${meshRevision}\0${worldDirectory}\0`);
    snapshot.update(`snapshot-v1\0${worldDirectory}\0`);
    const database = join(worldDirectory, "db");
    const names = (await readdir(database))
      .filter((name) => /\.(?:ldb|sst|log)$/i.test(name))
      .sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const details = await stat(join(database, name), { bigint: true });
      hash.update(`${name}\0${details.size}\0${details.mtimeNs}\n`);
      snapshot.update(`${name}\0${details.size}\0${details.mtimeNs}\n`);
    }
    return {
      terrain: hash.digest("hex").slice(0, 20),
      snapshot: snapshot.digest("hex").slice(0, 20),
    };
  }

  const loadDiscoveries = createDiscoveryCache({
    memoryMiB: options.discoveryMemoryMiB ?? 4,
    getSceneWorld,
    getSnapshotRevision,
  });

  /** Closes the world databases and worker threads. */
  async function close(): Promise<void> {
    const opened = [...worlds.values()];
    worlds.clear();
    await Promise.all(
      opened.map((world) =>
        world.then(
          (w) => w.close(),
          () => undefined,
        ),
      ),
    );
  }

  return {
    getSceneWorld,
    getWorldMetadata,
    loadRegion,
    getSnapshotRevision,
    loadDiscoveries,
    close,
  };
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${value}`);
  }
  return value;
}
