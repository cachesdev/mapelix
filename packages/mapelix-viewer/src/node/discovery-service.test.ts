import type { Dimension } from "@mapelix/scene-prototype";
import { decodeDiscoveryTile } from "@mapelix/scene-prototype/discoveries";
import { describe, expect, it } from "vitest";

import {
  DiscoveryService,
  discoveryTiles,
  emptyDiscoveryBytes,
  tileTouches,
  type BuildDiscoveries,
} from "./discovery-service.js";
import { InvalidRegionError, NotCachedError, type RegionStore } from "./region-service.js";

const WORLD = { minX: -40, minZ: 0, maxX: 40, maxZ: 31 };
const signal = (): AbortSignal => new AbortController().signal;

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

function service(build: BuildDiscoveries, store?: RegionStore): DiscoveryService {
  return new DiscoveryService({
    dimensions: new Map<Dimension, typeof WORLD | undefined>([
      ["overworld", WORLD],
      ["nether", undefined],
    ]),
    build,
    store,
    memoryBytes: 1024,
    memoryEntries: 2,
    maxPending: 2,
  });
}

describe("DiscoveryService", () => {
  it("lists the tiles of the stored area, nearest the middle first", () => {
    expect(tileTouches(WORLD, -2, 0)).toBe(true);
    expect(tileTouches(WORLD, -3, 0)).toBe(false);
    expect(tileTouches(WORLD, 0, 1)).toBe(false);
    const tiles = discoveryTiles(WORLD);
    expect(tiles).toHaveLength(4);
    expect(tiles.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { x: -1, z: 0 },
        { x: 0, z: 0 },
      ]),
    );
  });

  it("builds once, then serves from memory and disk; outside tiles cost nothing", async () => {
    const calls: { x: number; z: number; background: boolean | undefined }[] = [];
    const build: BuildDiscoveries = async (dimension, tile, _signal, background) => {
      calls.push({ ...tile, background });
      return { bytes: emptyDiscoveryBytes(dimension, tile.x, tile.z), milliseconds: 1 };
    };
    const store = memoryStore();
    const discoveries = service(build, store);
    const built = await discoveries.load("overworld", { x: 0, z: 0 }, signal(), {
      background: true,
    });
    expect(built.cacheStatus).toBe("build");
    expect(calls).toEqual([{ x: 0, z: 0, background: true }]);
    expect(store.files.has("overworld/0/0")).toBe(true);
    expect((await discoveries.load("overworld", { x: 0, z: 0 }, signal())).cacheStatus).toBe(
      "memory",
    );
    const fresh = service(build, store);
    expect(
      (await fresh.load("overworld", { x: 0, z: 0 }, signal(), { cacheOnly: true })).cacheStatus,
    ).toBe("disk");
    await expect(
      fresh.load("overworld", { x: 1, z: 0 }, signal(), { cacheOnly: true }),
    ).rejects.toBeInstanceOf(NotCachedError);
    const outside = await discoveries.load("overworld", { x: 50, z: 50 }, signal());
    expect(outside.cacheStatus).toBe("empty");
    expect(decodeDiscoveryTile(outside.bytes)).toMatchObject({ x: 50, z: 50, sourceChunks: 0 });
    expect((await discoveries.load("nether", { x: 0, z: 0 }, signal())).cacheStatus).toBe("empty");
    expect(calls).toHaveLength(1);
  });

  it("refuses unknown dimensions and coordinates, and drops corrupt files", async () => {
    const store = memoryStore();
    store.files.set("overworld/0/0", new Uint8Array(8));
    let built = 0;
    const discoveries = service(async (dimension, tile) => {
      built += 1;
      return { bytes: emptyDiscoveryBytes(dimension, tile.x, tile.z), milliseconds: 1 };
    }, store);
    await expect(discoveries.load("the-end", { x: 0, z: 0 }, signal())).rejects.toBeInstanceOf(
      InvalidRegionError,
    );
    await expect(
      discoveries.load("overworld", { x: 10_000_000, z: 0 }, signal()),
    ).rejects.toBeInstanceOf(InvalidRegionError);
    expect((await discoveries.load("overworld", { x: 0, z: 0 }, signal())).cacheStatus).toBe(
      "build",
    );
    expect(built).toBe(1);
  });
});
