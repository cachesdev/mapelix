import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { openBedrockWorld, type BedrockWorld, type TileCoverage } from "@mapelix/core";

const defaultWorldDirectory = "/tmp/mapelix-stratos-tmbcraft-pruned-v2";
const worldDirectory = process.env.STRATOS_WORLD_DIRECTORY ?? defaultWorldDirectory;

let worldPromise: Promise<BedrockWorld> | undefined;
let metadataPromise: Promise<StratosMetadata> | undefined;
const tileCache = new Map<string, Promise<Uint8Array>>();
const maxCachedTiles = 128;

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
  worldPromise ??= openBedrockWorld({ directory: worldDirectory });
  return worldPromise;
}

export function getStratosMetadata(): Promise<StratosMetadata> {
  metadataPromise ??= loadMetadata();
  return metadataPromise;
}

export function renderStratosTile(x: number, y: number): Promise<Uint8Array> {
  const key = `${x}/${y}`;
  const existing = tileCache.get(key);
  if (existing !== undefined) {
    tileCache.delete(key);
    tileCache.set(key, existing);
    return existing;
  }

  const pending = getStratosWorld().then(async (world) => {
    const tile = await world.renderTile({ dimension: "overworld", z: 0, x, y });
    return tile.png;
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

async function loadMetadata(): Promise<StratosMetadata> {
  const [world, rawName] = await Promise.all([
    getStratosWorld(),
    readFile(join(worldDirectory, "levelname.txt"), "utf8"),
  ]);
  const coverage = world.getTileCoverage("overworld");
  const hotspot = findHotspot(coverage);

  return {
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
