import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import { encodeDiscoveryTile } from "@mapelix/scene-prototype/discoveries";
import {
  EMPTY_HEIGHT,
  MAX_REGION_LEVEL,
  encodeSceneRegion,
  regionGridSize,
} from "@mapelix/scene-prototype/format";
import { NotCachedError, InvalidRegionError } from "./region-service";
import { MissingWorldError, createSceneServer, type SceneServerOptions } from "./scene-world";

const mocks = vi.hoisted(() => ({ opened: vi.fn(), built: vi.fn(), discovered: vi.fn() }));

vi.mock("@mapelix/scene-prototype", () => ({ openSceneWorld: mocks.opened }));
vi.mock("./revision.js", async (original) => ({
  ...(await original<typeof import("./revision.js")>()),
  engineFingerprint: async () => "engine",
}));

/** A real, decodable region whose heights tell which build made it. */
function region(level: number, x: number, z: number, tag: number): Uint8Array {
  const empty = new Uint32Array(0);
  return encodeSceneRegion({
    level,
    x,
    z,
    heights: new Int16Array(regionGridSize(level) ** 2).fill(tag === 0 ? EMPTY_HEIGHT : tag),
    minY: 0,
    maxY: 0,
    opaque: empty,
    plants: empty,
    translucent: empty,
  });
}

let root: string;
let options: SceneServerOptions;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-scene-"));
  const world = join(root, "world");
  await mkdir(join(world, "db"), { recursive: true });
  await writeFile(join(world, "level.dat"), "level");
  await writeFile(join(world, "db", "000001.ldb"), "table");
  options = {
    worldDirectory: world,
    cacheDirectory: join(root, "cache"),
    bounds: { minX: -64, minZ: -64, maxX: 63, maxZ: 63 },
  };
  mocks.opened.mockReset();
  mocks.built.mockReset();
  mocks.discovered.mockReset();
  mocks.opened.mockImplementation(async ({ dimension }: { dimension: string }) => ({
    info: { name: "Cache fixture", spawn: { x: -61, y: 69, z: 25 } },
    buildRegion: async (request: {
      level: number;
      x: number;
      z: number;
      ceilingY: number;
      mode?: string;
      minY?: number;
    }) => {
      mocks.built(dimension, request);
      const id = dimension === "overworld" ? 1 : dimension === "nether" ? 2 : 3;
      const tag =
        id * 1000 + request.ceilingY + (request.mode === "caves" ? 500 + request.minY! : 0);
      return { bytes: region(request.level, request.x, request.z, tag), milliseconds: 1 };
    },
    buildDiscoveries: async (tile: { x: number; z: number }) => {
      mocks.discovered(dimension, tile);
      return {
        bytes: encodeDiscoveryTile({
          dimension: dimension as "overworld",
          ...tile,
          sourceChunks: 1,
          blocks: new Uint32Array(0),
        }),
        milliseconds: 1,
      };
    },
    close: async () => {},
  }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("scene server", () => {
  it("refuses a folder without a world, and opens once the world is there", async () => {
    const server = createSceneServer({ ...options, worldDirectory: join(root, "missing") });
    await expect(server.ready()).rejects.toBeInstanceOf(MissingWorldError);
    await expect(server.loadRegion({ level: 0, x: 0, z: 0 }, signal)).rejects.toBeInstanceOf(
      MissingWorldError,
    );
    await expect(createSceneServer(options).ready()).resolves.toBeUndefined();
  });

  it("builds, remembers and stores each dimension and ceiling apart, across a restart", async () => {
    const server = createSceneServer(options);
    const request = { level: 0, x: -1, z: 0 };
    const contexts = [
      sceneContext(),
      sceneContext("nether"),
      sceneContext("the-end"),
      sceneContext("nether", 128),
    ];
    const outputs: string[] = [];
    for (const context of contexts) {
      const first = await server.loadRegion(request, signal, context);
      expect(first.cacheStatus).toBe("build");
      outputs.push(Array.from(first.bytes).join(","));
      const second = await server.loadRegion(request, signal, context);
      expect(second.cacheStatus).toBe("memory");
      expect(second.bytes).toEqual(first.bytes);
    }
    expect(new Set(outputs).size).toBe(4);
    expect(mocks.opened.mock.calls.map(([opened]) => opened.dimension)).toEqual([
      "overworld",
      "nether",
      "the-end",
    ]);
    // Surface builds keep their request shape: position and resolved ceiling only.
    expect(mocks.built.mock.calls[0]).toEqual(["overworld", { ...request, ceilingY: 320 }]);
    await server.close();

    const restarted = createSceneServer(options);
    for (const [index, context] of contexts.entries()) {
      const stored = await restarted.loadRegion(request, signal, context);
      expect(stored.cacheStatus).toBe("disk");
      expect(Array.from(stored.bytes).join(",")).toBe(outputs[index]);
    }
    expect(mocks.built).toHaveBeenCalledTimes(4);
    await restarted.close();
  });

  it("keeps cave slices apart from each other and from the Surface", async () => {
    const server = createSceneServer(options);
    const request = { level: 0, x: 0, z: 0 };
    const a = sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 });
    const b = sceneContext("overworld", { mode: "caves", minY: -48, maxY: -16 });
    const surface = await server.loadRegion(request, signal);
    const sliceA = await server.loadRegion(request, signal, a);
    const sliceB = await server.loadRegion(request, signal, b);
    expect(new Set([surface.bytes, sliceA.bytes, sliceB.bytes].map(String)).size).toBe(3);
    expect((await server.loadRegion(request, signal, a)).cacheStatus).toBe("memory");
    expect(mocks.built.mock.calls[1]![1]).toMatchObject({ mode: "caves", minY: -64, maxY: -32 });
    await expect(server.loadRegion({ ...request, level: 2 }, signal, a)).rejects.toBeInstanceOf(
      InvalidRegionError,
    );
    await server.close();
  });

  it("answers outside the bounds with an empty region and serves the cache only on demand", async () => {
    const server = createSceneServer(options);
    const outside = await server.loadRegion({ level: 0, x: 40, z: 40 }, signal);
    expect(outside.cacheStatus).toBe("empty");
    await expect(
      server.loadRegion({ level: 0, x: 0, z: 0 }, signal, sceneContext(), { cacheOnly: true }),
    ).rejects.toBeInstanceOf(NotCachedError);
    await expect(
      server.loadDiscoveries("overworld", { x: 0, z: 0 }, signal, { cacheOnly: true }),
    ).rejects.toBeInstanceOf(NotCachedError);
    expect(mocks.built).not.toHaveBeenCalled();
    expect((await server.loadDiscoveries("overworld", { x: 0, z: 0 }, signal)).cacheStatus).toBe(
      "build",
    );
    await server.close();
  });

  it("serves only the dimensions it is given", async () => {
    const server = createSceneServer({ ...options, dimensions: ["nether"] });
    expect((await server.getWorldMetadata(sceneContext("nether"))).dimensions).toHaveLength(1);
    await expect(server.loadRegion({ level: 0, x: 0, z: 0 }, signal)).rejects.toBeInstanceOf(
      InvalidRegionError,
    );
    await server.close();
  });

  it("provides dimension entry points without treating them as stored portal positions", async () => {
    const server = createSceneServer(options);
    expect((await server.getWorldMetadata()).spawn).toEqual({ x: -61, y: 69, z: 25 });
    expect((await server.getWorldMetadata(sceneContext("nether"))).spawn).toEqual({
      x: -8,
      y: 64,
      z: 3,
    });
    expect((await server.getWorldMetadata(sceneContext("the-end"))).spawn).toEqual({
      x: 100,
      y: 64,
      z: 0,
    });
    await server.close();
  });

  it("prewarms the stored area then its discoveries, and reports it", async () => {
    const server = createSceneServer({ ...options, dimensions: ["overworld"] });
    const result = await server.prewarm({ maxRegions: 1000 });
    expect(result.regions).toMatchObject({ state: "done", failed: 0 });
    expect(result.regions.total).toBeGreaterThan(MAX_REGION_LEVEL);
    expect(result.discoveries).toMatchObject({ state: "done", total: 16, built: 16 });
    // The same call returns the same run.
    expect(await server.prewarm()).toBe(result);
    const stats = await server.stats();
    expect(stats.prewarm).toEqual(result);
    expect(stats.surface.cache.entries).toBe(result.regions.built);
    expect(stats.openDimensions).toEqual(["overworld"]);
    await server.close();
  });

  it("removes older revisions from the cache when it opens", async () => {
    const old = join(options.cacheDirectory, "0123456789abcdef0123");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "keep-me-not.bin"), "old");
    const server = createSceneServer(options);
    const revision = await server.getRevision();
    expect(revision).toMatch(/^[0-9a-f]{20}$/);
    expect(await readdir(options.cacheDirectory)).not.toContain("0123456789abcdef0123");
    await server.close();
  });
});
