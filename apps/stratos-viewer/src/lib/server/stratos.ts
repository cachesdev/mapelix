import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { openBedrockWorld, type BedrockWorld, type TileCoverage } from "@mapelix/core";

const defaultWorldDirectory = "/home/caches/Repos/.mapelix-worlds/Amelix-8-12-26/Amelix SMP";
const worldDirectory =
  process.env.MAPELIX_WORLD_DIRECTORY ??
  process.env.STRATOS_WORLD_DIRECTORY ??
  defaultWorldDirectory;
const cacheDirectory =
  process.env.MAPELIX_CACHE_DIRECTORY ??
  process.env.STRATOS_CACHE_DIRECTORY ??
  "/tmp/mapelix-amelix-viewer-cache";
const renderConcurrency = positiveInteger(
  process.env.MAPELIX_RENDER_WORKERS ?? process.env.STRATOS_RENDER_WORKERS ?? "2",
);
const cacheFormat = "unmined-elevation-v2";

let worldPromise: Promise<BedrockWorld> | undefined;
let metadataPromise: Promise<StratosMetadataResult> | undefined;
let cacheNamespacePromise: Promise<string> | undefined;
const tileCache = new Map<string, Promise<StratosTileResult>>();
const maxCachedTiles = 128;

export type CacheStatus = "memory" | "disk" | "render";

export interface StratosTileResult {
  readonly png: Uint8Array;
  readonly cacheStatus: CacheStatus;
}

export interface StratosMetadataResult {
  readonly metadata: StratosMetadata;
  readonly cacheStatus: "memory" | "disk" | "index";
}

export interface StratosMetadata {
  readonly name: string;
  readonly tileCount: number;
  readonly subchunkCount: number;
  readonly bounds: {
    readonly minX: number;
    readonly minZ: number;
    readonly maxX: number;
    readonly maxZ: number;
  };
  readonly hotspot: {
    readonly x: number;
    readonly z: number;
    readonly subchunkCount: number;
  };
}

export function getStratosWorld(): Promise<BedrockWorld> {
  worldPromise ??= openBedrockWorld({
    directory: worldDirectory,
    renderConcurrency,
  });
  return worldPromise;
}

export function getStratosMetadata(): Promise<StratosMetadataResult> {
  if (metadataPromise !== undefined) {
    return metadataPromise.then((result) => ({ ...result, cacheStatus: "memory" }));
  }
  metadataPromise = loadMetadata();
  return metadataPromise;
}

export function renderStratosTile(z: number, x: number, y: number): Promise<StratosTileResult> {
  const key = `${z}/${x}/${y}`;
  const existing = tileCache.get(key);
  if (existing !== undefined) {
    tileCache.delete(key);
    tileCache.set(key, existing);
    return existing.then((result) => ({ ...result, cacheStatus: "memory" }));
  }

  const pending = loadPersistentTile(z, x, y).then(async (cached) => {
    if (cached !== undefined) {
      return { png: cached, cacheStatus: "disk" } as const;
    }
    const world = await getStratosWorld();
    const tile = await world.renderTile({ dimension: "overworld", z, x, y });
    await writePersistentTile(z, x, y, tile.png);
    return { png: tile.png, cacheStatus: "render" } as const;
  });
  tileCache.set(key, pending);
  trimTileCache();
  void pending.catch(() => tileCache.delete(key));
  return pending;
}

function trimTileCache(): void {
  while (tileCache.size > maxCachedTiles) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    tileCache.delete(oldest);
  }
}

async function loadMetadata(): Promise<StratosMetadataResult> {
  const metadataPath = join(await getCacheNamespace(), "metadata.json");
  const cached = await readCacheFile(metadataPath);
  if (cached !== undefined) {
    try {
      return {
        metadata: JSON.parse(new TextDecoder().decode(cached)) as StratosMetadata,
        cacheStatus: "disk",
      };
    } catch {
      // A partial or stale prototype cache is equivalent to a miss.
    }
  }

  const [world, rawName] = await Promise.all([
    getStratosWorld(),
    readFile(join(worldDirectory, "levelname.txt"), "utf8"),
  ]);
  const coverage = world.getTileCoverage("overworld");
  const hotspot = findHotspot(coverage);

  const metadata: StratosMetadata = {
    name: rawName.trim(),
    tileCount: coverage.length,
    subchunkCount: coverage.reduce((total, tile) => total + tile.subchunkCount, 0),
    bounds: coverageBounds(coverage),
    hotspot: {
      x: hotspot.x * 256 + 128,
      z: hotspot.y * 256 + 128,
      subchunkCount: hotspot.subchunkCount,
    },
  };
  await writeCacheFile(metadataPath, new TextEncoder().encode(JSON.stringify(metadata)));
  return { metadata, cacheStatus: "index" };
}

async function loadPersistentTile(
  z: number,
  x: number,
  y: number,
): Promise<Uint8Array | undefined> {
  return readCacheFile(await persistentTilePath(z, x, y));
}

async function writePersistentTile(
  z: number,
  x: number,
  y: number,
  png: Uint8Array,
): Promise<void> {
  await writeCacheFile(await persistentTilePath(z, x, y), png);
}

async function persistentTilePath(z: number, x: number, y: number): Promise<string> {
  return join(await getCacheNamespace(), "tiles", String(z), String(x), `${y}.png`);
}

async function getCacheNamespace(): Promise<string> {
  cacheNamespacePromise ??= fingerprintWorld().then((fingerprint) =>
    join(cacheDirectory, `${cacheFormat}-${fingerprint}`),
  );
  return cacheNamespacePromise;
}

async function fingerprintWorld(): Promise<string> {
  const hash = createHash("sha256");
  hash.update(cacheFormat);
  hash.update(worldDirectory);
  const databaseDirectory = join(worldDirectory, "db");
  const entries = (await readdir(databaseDirectory, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ldb") || entry.name.endsWith(".sst") || entry.name.endsWith(".log")),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
  const signatures = await Promise.all(
    entries.map(async (entry) => {
      const details = await stat(join(databaseDirectory, entry.name), { bigint: true });
      return `${entry.name}\0${details.size}\0${details.mtimeNs}\n`;
    }),
  );
  for (const signature of signatures) hash.update(signature);
  const levelName = await readFile(join(worldDirectory, "levelname.txt"));
  hash.update(levelName);
  return hash.digest("hex").slice(0, 20);
}

async function readCacheFile(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (cause) {
    if (isFileNotFound(cause)) return undefined;
    throw cause;
  }
}

async function writeCacheFile(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, bytes);
  await rename(temporaryPath, path);
}

function isFileNotFound(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

function positiveInteger(raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`MAPELIX_RENDER_WORKERS must be a positive integer, received ${raw}`);
  }
  return value;
}

function findHotspot(coverage: readonly TileCoverage[]): TileCoverage {
  return coverage.reduce<TileCoverage>(
    (best, tile) => (tile.subchunkCount > best.subchunkCount ? tile : best),
    { x: 0, y: 0, subchunkCount: 0 },
  );
}

function coverageBounds(coverage: readonly TileCoverage[]): StratosMetadata["bounds"] {
  if (coverage.length === 0) {
    return { minX: -256, minZ: -256, maxX: 256, maxZ: 256 };
  }

  let minTileX = Number.POSITIVE_INFINITY;
  let minTileY = Number.POSITIVE_INFINITY;
  let maxTileX = Number.NEGATIVE_INFINITY;
  let maxTileY = Number.NEGATIVE_INFINITY;
  for (const tile of coverage) {
    minTileX = Math.min(minTileX, tile.x);
    minTileY = Math.min(minTileY, tile.y);
    maxTileX = Math.max(maxTileX, tile.x);
    maxTileY = Math.max(maxTileY, tile.y);
  }
  return {
    minX: minTileX * 256,
    minZ: minTileY * 256,
    maxX: (maxTileX + 1) * 256,
    maxZ: (maxTileY + 1) * 256,
  };
}
