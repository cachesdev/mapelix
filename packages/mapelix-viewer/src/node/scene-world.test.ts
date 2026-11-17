import { beforeEach, describe, expect, it, vi } from "vitest";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import { createSceneServer, type SceneServerOptions } from "./scene-world";

const OPTIONS: SceneServerOptions = { worldDirectory: "/world", cacheDirectory: "/cache" };

const mocks = vi.hoisted(() => ({
  disk: new Map<string, Uint8Array>(),
  opened: vi.fn(),
  built: vi.fn(),
}));

vi.mock("@mapelix/scene-prototype", () => ({ openSceneWorld: mocks.opened }));
vi.mock("node:fs/promises", () => ({
  readdir: async () => ["000001.ldb"],
  stat: async () => ({ size: 100n, mtimeNs: 123n }),
  readFile: async (path: string) => {
    const bytes = mocks.disk.get(path);
    if (!bytes) throw new Error("ENOENT");
    return bytes;
  },
  mkdir: async () => {},
  writeFile: async (path: string, bytes: Uint8Array) => {
    mocks.disk.set(path, bytes);
  },
  rename: async (from: string, to: string) => {
    mocks.disk.set(to, mocks.disk.get(from)!);
    mocks.disk.delete(from);
  },
}));

beforeEach(() => {
  mocks.disk.clear();
  mocks.opened.mockReset();
  mocks.built.mockReset();
  mocks.opened.mockImplementation(async ({ dimension }: { dimension: string }) => ({
    info: { name: "Cache fixture", spawn: { x: -61, y: 69, z: 25 } },
    buildRegion: async (request: { ceilingY: number }) => {
      mocks.built(dimension, request);
      const id = dimension === "overworld" ? 0 : dimension === "nether" ? 1 : 2;
      return { bytes: new Uint8Array([id, request.ceilingY / 16]), milliseconds: 1 };
    },
    close: async () => {},
  }));
});

describe("dimension server caches", () => {
  it("bounds cave bytes independently of Surface and does not accumulate cave disk variants", async () => {
    mocks.opened.mockImplementation(async () => ({
      info: { name: "Caves", spawn: { x: 0, y: 80, z: 0 } },
      buildRegion: async (request: { mode?: string; minY?: number }) => {
        mocks.built(request);
        return {
          bytes: new Uint8Array(request.mode === "caves" ? 600 * 1024 : 12),
          milliseconds: 1,
        };
      },
      close: async () => {},
    }));
    const server = createSceneServer({ ...OPTIONS, caveMemoryMiB: 1 });
    const request = { level: 0, x: 0, z: 0 },
      signal = new AbortController().signal;
    await server.loadRegion(request, signal);
    const a = sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 });
    const b = sceneContext("overworld", { mode: "caves", minY: -48, maxY: -16 });
    await server.loadRegion(request, signal, a);
    expect((await server.loadRegion(request, signal, a)).cacheStatus).toBe("memory");
    await server.loadRegion(request, signal, b);
    expect((await server.loadRegion(request, signal, a)).cacheStatus).toBe("build");
    expect((await server.loadRegion(request, signal)).cacheStatus).toBe("memory");
    expect(mocks.disk.size).toBe(1);
    expect(mocks.opened).toHaveBeenCalledTimes(1);
    expect(() => server.loadRegion({ ...request, level: 2 }, signal, a)).toThrow("LOD");
  });
  it("isolates memory, workers and persisted regions, including after a server restart", async () => {
    const server = createSceneServer(OPTIONS);
    const request = { level: 0, x: -1, z: 0 };
    const signal = new AbortController().signal;
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
    expect(mocks.opened.mock.calls.map(([options]) => options.dimension)).toEqual([
      "overworld",
      "nether",
      "the-end",
    ]);
    expect(mocks.disk.size).toBe(4);
    const restarted = createSceneServer(OPTIONS);
    for (const [index, context] of contexts.entries()) {
      const stored = await restarted.loadRegion(request, signal, context);
      expect(stored.cacheStatus).toBe("disk");
      expect(Array.from(stored.bytes).join(",")).toBe(outputs[index]);
    }
    expect(mocks.built).toHaveBeenCalledTimes(4);
  });

  it("provides dimension entry points without treating them as stored portal positions", async () => {
    const server = createSceneServer(OPTIONS);
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
  });
});
