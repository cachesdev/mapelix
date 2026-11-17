import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSceneHandler, createTileHandler } from "./http";
import type { SceneServer } from "./scene-world";

const GENERATION = "a".repeat(64);

function fakeServer() {
  return {
    getWorldMetadata: vi.fn(async () => ({ revision: "r1", name: "Fixture" })),
    getSnapshotRevision: vi.fn(async () => "s1"),
    loadRegion: vi.fn(async (_request: unknown) => ({
      bytes: new Uint8Array([1, 2, 3]),
      cacheStatus: "build" as const,
      milliseconds: 2,
    })),
    loadDiscoveries: vi.fn(async () => ({
      bytes: new Uint8Array([4]),
      cacheStatus: "memory" as const,
      milliseconds: 1,
    })),
  };
}

const get = (path: string, init?: RequestInit) => new Request(`http://local${path}`, init);

describe("scene handler", () => {
  it("serves metadata, regions and discoveries below its base path", async () => {
    const server = fakeServer();
    const handle = createSceneHandler(server as unknown as SceneServer, "/world");
    const metadata = await handle(get("/world/world.json?dimension=nether"));
    expect(metadata?.status).toBe(200);
    expect(await metadata?.json()).toEqual({ revision: "r1", name: "Fixture" });

    const region = await handle(get("/world/regions/1/-2/3?revision=r1"));
    expect(region?.headers.get("cache-control")).toContain("immutable");
    expect(region?.headers.get("x-mapelix-cache")).toBe("build");
    expect(new Uint8Array(await region!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(server.loadRegion.mock.calls[0]![0]).toEqual({ level: 1, x: -2, z: 3 });

    const discoveries = await handle(get("/world/discoveries/0/0.bin?dimension=overworld"));
    expect(discoveries?.headers.get("cache-control")).toBe("no-cache");
    expect(await handle(get("/regions/1/0/0"))).toBeUndefined();
    expect(await handle(get("/world/other"))).toBeUndefined();
    expect(await handle(get("/world/world.json", { method: "POST" }))).toBeUndefined();
  });

  it("refuses invalid requests and stale revisions with JSON errors", async () => {
    const handle = createSceneHandler(fakeServer() as unknown as SceneServer);
    for (const [path, status] of [
      ["/regions/99/0/0", 400],
      ["/regions/0/x/0", 400],
      ["/regions/0/0/0?revision=old", 409],
      ["/discoveries/0/0.bin?filter=ore", 400],
      ["/discoveries/0/0.bin?revision=old", 409],
      ["/world.json?dimension=moon", 400],
    ] as const) {
      const response = await handle(get(path));
      expect(response?.status, path).toBe(status);
      expect(typeof (await response!.json()).message).toBe("string");
    }
  });

  it("answers a cancelled region request with 499", async () => {
    const server = fakeServer();
    server.loadRegion.mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    const handle = createSceneHandler(server as unknown as SceneServer);
    expect((await handle(get("/regions/0/0/0")))?.status).toBe(499);
  });
});

describe("tile handler", () => {
  let root: string, outside: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "mapelix-tiles-"));
    outside = await mkdtemp(join(tmpdir(), "mapelix-outside-"));
    await writeFile(join(root, "manifest.json"), '{"generation":"x"}');
    await mkdir(join(root, "generations", GENERATION, "overworld", "tiles", "0", "-1"), {
      recursive: true,
    });
    await writeFile(join(root, "generations", GENERATION, "overworld/tiles/0/-1/2.png"), "png");
    await writeFile(join(outside, "secret.png"), "secret");
    await symlink(outside, join(root, "generations", GENERATION, "linked"), "junction").catch(
      () => undefined,
    );
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("serves the manifest uncached and generation files as immutable", async () => {
    const handle = createTileHandler(root, "/tiles");
    const manifest = await handle(get("/tiles/manifest.json"));
    expect(manifest?.headers.get("cache-control")).toBe("no-cache");
    expect(await manifest?.text()).toBe('{"generation":"x"}');
    const tile = await handle(get(`/tiles/generations/${GENERATION}/overworld/tiles/0/-1/2.png`));
    expect(tile?.headers.get("content-type")).toBe("image/png");
    expect(tile?.headers.get("cache-control")).toContain("immutable");
    expect(await tile?.text()).toBe("png");
    const head = await handle(get("/tiles/manifest.json", { method: "HEAD" }));
    expect(head?.headers.get("content-length")).toBe("18");
  });

  it("serves an export folder created after the first request", async () => {
    const later = join(outside, "later");
    const handle = createTileHandler(later);
    expect((await handle(get("/manifest.json")))?.status).toBe(404);
    await mkdir(later);
    await writeFile(join(later, "manifest.json"), "{}");
    const response = await handle(get("/manifest.json"));
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("{}");
  });

  it("leaves other paths to the host and refuses paths that leave the folder", async () => {
    const handle = createTileHandler(root, "/tiles");
    expect(await handle(get("/tiles/other.json"))).toBeUndefined();
    expect(await handle(get("/tiles/generations/short/x.png"))).toBeUndefined();
    expect(await handle(get("/elsewhere/manifest.json"))).toBeUndefined();
    const missing = await handle(get(`/tiles/generations/${GENERATION}/overworld/none.png`));
    expect(missing?.status).toBe(404);
    // Encoded separators stay inside one segment and are refused.
    const encoded = await handle(
      get(`/tiles/generations/${GENERATION}/..%2F..%2F..%2Foutside.png`),
    );
    expect(encoded?.status).toBe(400);
    const linked = await handle(get(`/tiles/generations/${GENERATION}/linked/secret.png`));
    expect(linked?.status).toBe(404);
  });
});
