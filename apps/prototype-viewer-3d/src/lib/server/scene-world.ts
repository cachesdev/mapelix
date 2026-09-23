import { createHash, randomUUID } from "node:crypto";
import { availableParallelism } from "node:os";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { openSceneWorld, type RegionRequest, type SceneWorld } from "@mapelix/scene-prototype";
import { REGION_FORMAT_VERSION } from "@mapelix/scene-prototype/format";

const worldDirectory =
  process.env.MAPELIX_WORLD_DIRECTORY ??
  resolve(process.cwd(), "../../.local/worlds/Amelix-8-12-26/Amelix SMP");
const cacheDirectory = process.env.MAPELIX_CACHE_DIRECTORY ?? "/tmp/mapelix-scene-cache";
const workers = positiveInteger(
  process.env.MAPELIX_SCENE_WORKERS ?? String(Math.min(8, Math.max(2, availableParallelism() - 2))),
);
/** Bump when mesh output changes without a format change, so stale disk caches are ignored. */
const meshRevision = 4;
const maxMemoryRegions = 384;

export type CacheStatus = "memory" | "disk" | "build";

export interface LoadedRegion {
  readonly bytes: Uint8Array;
  readonly cacheStatus: CacheStatus;
  readonly milliseconds: number;
}

export interface WorldMetadata {
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  /** Changes whenever the world files or the mesh output change. */
  readonly revision: string;
}

let worldPromise: Promise<SceneWorld> | undefined;
let revisionPromise: Promise<string> | undefined;
const memory = new Map<string, Promise<LoadedRegion>>();

export function getSceneWorld(): Promise<SceneWorld> {
  worldPromise ??= openSceneWorld({ directory: worldDirectory, workers });
  return worldPromise;
}

export async function getWorldMetadata(): Promise<WorldMetadata> {
  const [world, revision] = await Promise.all([getSceneWorld(), getRevision()]);
  return { name: world.info.name, spawn: world.info.spawn, revision };
}

/**
 * Returns a serialized region from memory, the disk cache, or a fresh build.
 * A cancelled request stops a queued build, but never a build already running.
 */
export function loadRegion(request: RegionRequest, signal: AbortSignal): Promise<LoadedRegion> {
  const key = `${request.level}/${request.x}/${request.z}`;
  const cached = memory.get(key);
  if (cached !== undefined) {
    memory.delete(key);
    memory.set(key, cached);
    return cached.then((region) => ({ ...region, cacheStatus: "memory" }));
  }

  const pending = readOrBuild(request, key, signal);
  memory.set(key, pending);
  void pending.catch(() => memory.delete(key));
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
): Promise<LoadedRegion> {
  const startedAt = performance.now();
  const path = join(cacheDirectory, await getRevision(), `${key}.bin`);
  const stored = await readFile(path).catch(() => undefined);
  if (stored !== undefined) {
    return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
  }

  const world = await getSceneWorld();
  const built = await world.buildRegion(request, signal);
  await writeAtomically(path, built.bytes);
  return { bytes: built.bytes, cacheStatus: "build", milliseconds: built.milliseconds };
}

function getRevision(): Promise<string> {
  revisionPromise ??= fingerprintWorld();
  return revisionPromise;
}

/** Hashes table names, sizes, and modification times. Reading the tables is not needed. */
async function fingerprintWorld(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`scene-v${REGION_FORMAT_VERSION}-mesh-v${meshRevision}\0${worldDirectory}\0`);
  const database = join(worldDirectory, "db");
  const names = (await readdir(database))
    .filter((name) => /\.(?:ldb|sst|log)$/i.test(name))
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const details = await stat(join(database, name), { bigint: true });
    hash.update(`${name}\0${details.size}\0${details.mtimeNs}\n`);
  }
  return hash.digest("hex").slice(0, 20);
}

async function writeAtomically(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, path);
}

function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`MAPELIX_SCENE_WORKERS must be a positive integer, received ${raw}`);
  }
  return value;
}
