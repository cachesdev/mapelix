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
import { decodeTextureAtlas } from "@mapelix/scene-prototype/texture-format";
import {
  makePng,
  makeZip,
  packFiles,
} from "../../../mapelix-scene-prototype/test/synthetic-pack.js";
import { NotCachedError, InvalidRegionError } from "./region-service";
import { MissingWorldError, createSceneServer, type SceneServerOptions } from "./scene-world";
import { writeFixtureManifest } from "../../../mapelix-prototype/test/leveldb-fixture.js";

const mocks = vi.hoisted(() => ({ opened: vi.fn(), built: vi.fn(), discovered: vi.fn() }));

vi.mock("@mapelix/scene-prototype", () => ({ openSceneWorld: mocks.opened }));
vi.mock("./revision.js", async (original) => ({
  ...(await original<typeof import("./revision.js")>()),
  engineFingerprint: async () => "engine",
}));

/** A real, decodable region whose heights tell which build made it. */
function region(level: number, x: number, z: number, tag: number, textured = false): Uint8Array {
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
    ...(textured ? { textures: { opaque: empty, plants: empty, translucent: empty } } : {}),
  });
}

let root: string;
let options: SceneServerOptions;
const signal = new AbortController().signal;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-scene-"));
  const world = join(root, "world");
  await mkdir(join(world, "db"), { recursive: true });
  await writeFixtureManifest(world);
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
      textures?: unknown;
    }) => {
      mocks.built(dimension, request);
      const id = dimension === "overworld" ? 1 : dimension === "nether" ? 2 : 3;
      const tag =
        id * 1000 + request.ceilingY + (request.mode === "caves" ? 500 + request.minY! : 0);
      return {
        bytes: region(request.level, request.x, request.z, tag, request.textures !== undefined),
        milliseconds: 1,
      };
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
    // Without level.dat the world opens with a default name and spawn.
    await rm(join(options.worldDirectory, "level.dat"));
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

  it("serves the atlas of a stack folder, built once on demand, and lists the packs", async () => {
    const stack = join(root, "stack");
    await mkdir(stack);
    await writeFile(
      join(stack, "pack.mcpack"),
      makeZip(
        packFiles({
          name: "Synthetic",
          uuid: "00000000-0000-4000-8000-0000000000c1",
          version: [1, 2, 3],
          terrain: { stone: { textures: "textures/blocks/stone" } },
          blocks: { stone: { textures: "stone" } },
          images: { "textures/blocks/stone.png": makePng(16, [9, 8, 7, 255]) },
        }),
      ),
    );
    await writeFile(
      join(stack, "mapelix-stack.json"),
      JSON.stringify({
        format: "mapelix-texture-stack",
        version: 1,
        packs: [
          { path: "pack.mcpack", uuid: "00000000-0000-4000-8000-0000000000c1", version: "1.2.3" },
        ],
      }),
    );
    const events: string[] = [];
    const textured = {
      ...options,
      textures: { stack },
      onEvent: (name: string) => void events.push(name),
    };
    const server = createSceneServer(textured);
    const metadata = await server.getWorldMetadata();
    expect(metadata.textures).toEqual({
      revision: expect.stringMatching(/^[0-9a-f]{20}$/) as unknown,
      packs: [
        { name: "Synthetic", version: "1.2.3", uuid: "00000000-0000-4000-8000-0000000000c1" },
      ],
    });
    const revision = metadata.textures!.revision;
    expect(revision).not.toBe(metadata.revision);
    // Opening reads the packs; the atlas waits for its first request, and cache-only never builds.
    expect((await server.stats()).textures).toMatchObject({ revision, state: "not-built" });
    expect(await server.loadTextureAtlas(revision, { cacheOnly: true })).toBeUndefined();
    const loaded = (await server.loadTextureAtlas(revision))!;
    const atlas = decodeTextureAtlas(loaded.bytes);
    // The tile starts after its 4-pixel gutter, which repeats it.
    const at = (4 * 24 + 4) * 4;
    expect(Array.from(atlas.levels[0]!.subarray(at, at + 4))).toEqual([9, 8, 7, 255]);
    expect(Array.from(atlas.levels[0]!.subarray(0, 4))).toEqual([9, 8, 7, 255]);
    expect(loaded.brotli.byteLength).toBeLessThan(loaded.bytes.byteLength);
    expect(await server.loadTextureNotices(revision)).toEqual([
      {
        pack: expect.objectContaining({ name: "Synthetic" }) as unknown,
        files: ["textures/blocks/stone.png"],
      },
    ]);
    expect(await server.loadTextureAtlas("0".repeat(20))).toBeUndefined();
    expect((await server.stats()).textures).toMatchObject({
      revision,
      state: "stored",
      atlas: {
        tileSize: 16,
        tiles: 1,
        gpuBytes: atlas.levels.reduce((s, l) => s + l.byteLength, 0),
      },
    });
    await server.close();
    expect(events.filter((name) => name === "textures.built")).toHaveLength(1);

    // A restart reads the stored atlas, which a cache-only request may then serve.
    const restarted = createSceneServer(textured);
    expect((await restarted.getWorldMetadata()).textures?.revision).toBe(revision);
    expect(await restarted.loadTextureAtlas(revision, { cacheOnly: true })).toBeDefined();
    await restarted.close();
    expect(events).toContain("textures.cache-hit");

    // Another stack is another revision; the old atlas leaves the disk.
    const other = createSceneServer({ ...textured, textures: { stack, maxTileSize: 8 } });
    const changed = (await other.getWorldMetadata()).textures!.revision;
    expect(changed).not.toBe(revision);
    expect(await readdir(join(options.cacheDirectory, "textures", "atlas-v2"))).toEqual([]);
    await other.close();
    expect(events).toContain("textures.cache-removed");

    // Without a stack the metadata does not change at all.
    const plain = createSceneServer(options);
    expect(await plain.getWorldMetadata()).not.toHaveProperty("textures");
    await plain.close();
  });

  it("builds textured level 0 Surface regions apart, with the atlas index, and prewarms them", async () => {
    const pack = join(root, "pack.zip");
    await writeFile(
      pack,
      makeZip(
        packFiles({
          terrain: { stone: { textures: "textures/blocks/stone" } },
          blocks: { stone: { textures: "stone" } },
          images: { "textures/blocks/stone.png": makePng(16, [9, 8, 7, 255]) },
        }),
      ),
    );
    const server = createSceneServer({ ...options, textures: { packs: [pack] } });
    const revision = (await server.getWorldMetadata()).textures!.revision;
    const request = { level: 0, x: 0, z: 0 };
    await expect(
      server.loadRegion(request, signal, sceneContext(), { textures: revision, cacheOnly: true }),
    ).rejects.toBeInstanceOf(NotCachedError);
    const textured = await server.loadRegion(request, signal, sceneContext(), {
      textures: revision,
    });
    expect(textured.cacheStatus).toBe("build");
    expect(textured.bytes[7]).toBe(1);
    const sent = mocks.built.mock.calls.at(-1)![1] as { textures: { fingerprint: string } };
    expect(sent.textures.fingerprint).toBe(revision);
    const plain = await server.loadRegion(request, signal);
    expect(plain.bytes[7]).toBe(0);
    await expect(
      server.loadRegion(request, signal, sceneContext(), { textures: "0".repeat(20) }),
    ).rejects.toBeInstanceOf(InvalidRegionError);
    // Cave slices have a textured variant too, built on demand and cached apart.
    const slice = sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 });
    const cave = await server.loadRegion(request, signal, slice, { textures: revision });
    expect(cave.cacheStatus).toBe("build");
    expect(cave.bytes[7]).toBe(1);
    expect(mocks.built.mock.calls.at(-1)![1]).toMatchObject({
      mode: "caves",
      minY: -64,
      maxY: -32,
      textures: { fingerprint: revision },
    });
    const detailed = await server.loadRegion(request, signal, slice, {
      textures: revision,
      cutout: true,
    });
    expect(detailed.cacheStatus).toBe("build");
    expect(mocks.built.mock.calls.at(-1)![1]).toMatchObject({ mode: "caves", cutout: true });
    expect(
      (await server.loadRegion(request, signal, slice, { textures: revision })).cacheStatus,
    ).toBe("memory");
    expect((await server.loadRegion(request, signal, slice)).bytes[7]).toBe(0);
    expect((await server.stats()).texturedCaves?.builds.built).toBe(2);
    await expect(
      server.loadRegion({ level: 1, x: 0, z: 0 }, signal, sceneContext(), { textures: revision }),
    ).rejects.toBeInstanceOf(InvalidRegionError);
    expect(await server.getTextureRevision()).toBe(revision);

    const result = await server.prewarm({ maxRegions: 1000, discoveries: false });
    expect(result.textures).toMatchObject({ state: "done", failed: 0 });
    expect(result.textures.total).toBeGreaterThan(0);
    expect((await server.stats()).textured?.cache.entries).toBe(result.textures.total);
    await server.close();

    // Without textures, the prewarm leaves them idle and the stats say nothing.
    const plainServer = createSceneServer(options);
    expect((await plainServer.prewarm({ maxRegions: 10, discoveries: false })).textures.state).toBe(
      "idle",
    );
    expect(await plainServer.stats()).not.toHaveProperty("textured");
    await plainServer.close();
  });

  it("serves the world untextured when a pack cannot be read, and says why", async () => {
    const broken = join(root, "broken.zip");
    await writeFile(broken, "not a zip");
    const server = createSceneServer({ ...options, textures: { packs: [broken] } });

    expect(await server.getWorldMetadata()).not.toHaveProperty("textures");
    expect((await server.stats()).textures).toEqual({
      error: expect.stringMatching(/broken\.zip: is not a zip archive/) as unknown,
    });
    await server.close();
  });

  it("replaces the texture stack while running, and keeps it when a new one is refused", async () => {
    const zip = async (name: string, color: readonly [number, number, number, number]) => {
      const path = join(root, name);
      await writeFile(
        path,
        makeZip(
          packFiles({
            terrain: { stone: { textures: "textures/blocks/stone" } },
            blocks: { stone: { textures: "stone" } },
            images: { "textures/blocks/stone.png": makePng(16, color) },
          }),
        ),
      );
      return path;
    };
    const first = await zip("first.zip", [9, 8, 7, 255]);
    const second = await zip("second.zip", [1, 2, 3, 255]);
    const events: string[] = [];
    const server = createSceneServer({ ...options, onEvent: (name) => events.push(name) });
    const atlases = join(options.cacheDirectory, "textures", "atlas-v2");
    const regions = join(options.cacheDirectory, "textures", "regions");
    const request = { level: 0, x: 0, z: 0 };
    expect(await server.getWorldMetadata()).not.toHaveProperty("textures");

    const added = await server.setTextures({ packs: [first] });
    expect(added).toMatchObject({ ok: true, errors: [], packs: [{ name: "Synthetic pack" }] });
    const revision = added.revision!;
    expect((await server.getWorldMetadata()).textures?.revision).toBe(revision);
    expect(await server.loadTextureAtlas(revision, { cacheOnly: true })).toBeDefined();
    const prewarmed = await server.prewarm({ maxRegions: 1000, discoveries: false });
    expect(prewarmed.textures).toMatchObject({ state: "done", failed: 0 });

    // A broken stack changes nothing; the same stack again builds nothing.
    const broken = join(root, "broken.zip");
    await writeFile(broken, "not a zip");
    expect(await server.setTextures({ packs: [broken] })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/broken\.zip: is not a zip archive/) as unknown],
    });
    expect(await server.getTextureRevision()).toBe(revision);
    expect((await server.setTextures({ packs: [first] })).revision).toBe(revision);
    expect(events.filter((name) => name === "textures.built")).toHaveLength(1);

    // Another stack takes over; the previous revision is no longer served nor stored.
    const swapped = await server.setTextures({ packs: [second] });
    const next = swapped.revision!;
    expect(next).not.toBe(revision);
    expect(await server.getTextureRevision()).toBe(next);
    await expect(
      server.loadRegion(request, signal, sceneContext(), { textures: revision }),
    ).rejects.toBeInstanceOf(InvalidRegionError);
    expect(await server.loadTextureAtlas(revision)).toBeUndefined();
    expect(await readdir(atlases)).toEqual([next]);
    expect(await readdir(regions)).toHaveLength(1);
    // The prewarm, which already reached the textured regions, builds them again for it.
    await vi.waitFor(async () => {
      const stats = await server.stats();
      expect(stats.prewarm.textures).toMatchObject({ state: "done", failed: 0 });
      expect(stats.textured?.cache.entries).toBe(prewarmed.textures.total);
    });
    const textured = await server.loadRegion(request, signal, sceneContext(), { textures: next });
    expect(textured.cacheStatus).not.toBe("build");

    // Changes run in turn: the last one wins.
    const [, last] = await Promise.all([
      server.setTextures({ packs: [first] }),
      server.setTextures({ packs: [second] }),
    ]);
    expect(await server.getTextureRevision()).toBe(last.revision);

    // An image too large for the limits is skipped alone: the next pack's takes its place.
    const huge = makePng(16, [5, 5, 5, 255]);
    new DataView(huge.buffer, huge.byteOffset).setUint32(20, 100_000);
    const oversized = join(root, "oversized.zip");
    await writeFile(
      oversized,
      makeZip(
        packFiles({
          name: "Oversized",
          uuid: "00000000-0000-4000-8000-0000000000c1",
          terrain: { stone: { textures: "textures/blocks/stone" } },
          blocks: { stone: { textures: "stone" } },
          images: { "textures/blocks/stone.png": huge },
        }),
      ),
    );
    const over = await server.setTextures({ packs: [oversized, second] });
    expect(over).toMatchObject({
      ok: true,
      skipped: [
        {
          pack: { name: "Oversized" },
          file: "textures/blocks/stone.png",
          reason: "image is wider or taller than 8192 pixels",
        },
      ],
      notices: [{ pack: { name: "Synthetic pack" }, files: ["textures/blocks/stone.png"] }],
    });
    expect(await server.getTextureRevision()).toBe(over.revision);
    expect(events).toContain("textures.images-skipped");

    expect(await server.setTextures(null)).toEqual({ ok: true, errors: [] });
    expect(await server.getWorldMetadata()).not.toHaveProperty("textures");
    expect(await server.stats()).not.toHaveProperty("textured");
    expect(await readdir(atlases)).toEqual([]);
    expect(await readdir(regions)).toEqual([]);
    expect(events).toContain("textures.changed");
    await server.close();
    await expect(server.setTextures({ packs: [first] })).rejects.toThrow(/closed/);
  });
});
