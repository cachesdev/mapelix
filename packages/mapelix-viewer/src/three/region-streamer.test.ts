import { afterEach, describe, expect, it, vi } from "vitest";
import { Group, PerspectiveCamera } from "three/webgpu";
import { EMPTY_HEIGHT, encodeSceneRegion, regionGridSize } from "@mapelix/scene-prototype/format";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import type { SceneMaterials } from "./shaders/materials";
import { RegionStreamer, type StreamingOptions } from "./region-streamer";
import { ViewCamera } from "./view-projection";

const constructed = vi.hoisted(() => vi.fn());
vi.mock("./region-mesh", () => ({
  RegionMesh: class {
    readonly isEmpty = false;
    readonly byteLength = 12;
    readonly group = new Group();
    constructor(readonly region: unknown) {
      constructed(region);
    }
    dispose() {}
    setFade() {}
  },
}));

function stream(dimension: "overworld" | "nether", overrides: Partial<StreamingOptions> = {}) {
  return new RegionStreamer({
    context: sceneContext(dimension),
    revision: "test-revision",
    materials: {} as SceneMaterials,
    voxelPixels: 2.2,
    blockPixels: 4.4,
    viewDistance: 1,
    maxRequests: 1,
    memoryBudget: 1024,
    onRegion: vi.fn(),
    ...overrides,
  });
}

function request(streamer: RegionStreamer) {
  const camera = new PerspectiveCamera(50, 1, 1, 1000);
  camera.position.set(0, 80, 0);
  camera.lookAt(0, 64, -10);
  streamer.update(camera, 600);
}

function response() {
  const empty = new Uint32Array(0);
  const bytes = encodeSceneRegion({
    level: 0,
    x: 0,
    z: 0,
    minY: 0,
    maxY: 0,
    heights: new Int16Array(64 * 64).fill(EMPTY_HEIGHT),
    opaque: empty,
    plants: empty,
    translucent: empty,
  });
  return new Response(new Uint8Array(bytes).buffer);
}

afterEach(() => {
  vi.unstubAllGlobals();
  constructed.mockClear();
});

describe("dimension streaming lifecycle", () => {
  it("never uses a cached/drawn coarse height as exact Surface evidence", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const [level, x, z] = new URL(String(input), "http://localhost").pathname
        .split("/")
        .slice(-3)
        .map(Number);
      return new Response(
        new Uint8Array(
          encodeSceneRegion({
            level: level!,
            x: x!,
            z: z!,
            minY: 0,
            maxY: 81,
            heights: new Int16Array(regionGridSize(level!) ** 2).fill(81),
            opaque: new Uint32Array(),
            plants: new Uint32Array(),
            translucent: new Uint32Array(),
          }),
        ).buffer,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("overworld", {
      viewDistance: 128,
      voxelPixels: 0.01,
      blockPixels: 1e9,
    });
    const camera = new PerspectiveCamera(50, 1, 1, 1000);
    camera.position.set(16, 200, 16);
    camera.lookAt(16, 80, 16);
    streamer.update(camera, 600);
    await vi.waitFor(() => expect(streamer.stats.cached).toBe(1));
    streamer.update(camera, 600);
    expect(streamer.heightAt(16, 16)).toBe(81);
    expect(streamer.exactHeightAt(16, 16)).toBeUndefined();
    expect(streamer.isSurfaceBlock(16, 80, 16)).toBe(false);
    streamer.dispose();
  });
  it("pauses scheduling after a 429 instead of retrying every frame", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: { "retry-after": "60" },
      }),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("overworld");
    try {
      request(streamer);
      await vi.waitFor(() => expect(warning).toHaveBeenCalledTimes(1));
      for (let i = 0; i < 120; i++) request(streamer);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(streamer.stats.remaining).toBeGreaterThan(0);
    } finally {
      streamer.dispose();
      warning.mockRestore();
    }
  });
  it("uses canonical negative bounds, near LODs and an embedded base/suffix for caves", () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("overworld", {
      context: sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 }),
      regionBase: "/custom/regions",
      regionSuffix: ".bin",
      viewDistance: 128,
      maxRequests: 20,
    });
    const camera = new PerspectiveCamera(50, 1, 1, 1000);
    camera.position.set(0, -40, 0);
    camera.lookAt(0, -48, -10);
    streamer.update(camera, 600);
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    for (const [input] of fetcher.mock.calls) {
      const url = new URL(String(input), "http://localhost");
      expect(url.pathname).toMatch(/^\/custom\/regions\/[01]\/[-\d]+\/[-\d]+\.bin$/);
      expect(url.searchParams.get("minY")).toBe("-64");
      expect(url.searchParams.get("maxY")).toBe("-32");
      expect(url.searchParams.get("mode")).toBe("caves");
      expect(url.searchParams.get("revision")).toBe("test-revision");
    }
    streamer.dispose();
  });
  it("qualifies region requests by dimension, ceiling and revision", () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("nether");
    request(streamer);
    const url = new URL(fetcher.mock.calls[0]![0] as string, "http://localhost");
    expect(url.searchParams.get("dimension")).toBe("nether");
    expect(url.searchParams.get("ceilingY")).toBe("96");
    expect(url.searchParams.get("revision")).toBe("test-revision");
    streamer.dispose();
  });

  it("aborts the previous dimension and ignores its late response after switching", async () => {
    let finishOld!: (response: Response) => void;
    const oldResponse = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const fetcher = vi.fn().mockReturnValueOnce(oldResponse).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetcher);
    const overworld = stream("overworld");
    request(overworld);
    overworld.dispose();
    const nether = stream("nether");
    request(nether);
    await vi.waitFor(() => expect(nether.stats.cached).toBe(1));
    const oldSignal = (fetcher.mock.calls[0]![1] as RequestInit).signal;
    expect(oldSignal?.aborted).toBe(true);
    finishOld(response());
    await oldResponse;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(overworld.stats.cached).toBe(0);
    expect(constructed).toHaveBeenCalledTimes(1);
    nether.dispose();
  });
});

describe("level of detail under an isometric projection", () => {
  function requests(camera: PerspectiveCamera): string[] {
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetcher);
    const streamer = stream("overworld", { viewDistance: 2048, maxRequests: 10_000 });
    streamer.update(camera, 600);
    streamer.dispose();
    vi.unstubAllGlobals();
    return fetcher.mock.calls
      .map(([input]) => new URL(String(input), "http://localhost").pathname)
      .sort();
  }

  function view(blend: number, focusDistance: number, kind = ViewCamera): PerspectiveCamera {
    const camera = new kind(50, 1.5, 1, 6000);
    camera.position.set(0, 64 + focusDistance * 0.7, focusDistance * 0.7);
    camera.lookAt(0, 64, 0);
    camera.updateMatrixWorld();
    if (camera instanceof ViewCamera) {
      camera.projectionBlend = blend;
      camera.focusDistance = focusDistance;
    }
    camera.updateProjectionMatrix();
    return camera;
  }

  const levels = (paths: string[]) => paths.map((path) => Number(path.split("/")[2]));

  it("requests exactly the same regions as before in perspective", () => {
    expect(requests(view(0, 300))).toEqual(requests(view(0, 300, PerspectiveCamera as never)));
  });

  it("refines by on-screen scale, only inside the view", () => {
    const perspective = levels(requests(view(0, 1200)));
    const isometric = levels(requests(view(1, 1200)));
    // Far out, perspective still refines next to the camera; an isometric view does not.
    expect(Math.min(...perspective)).toBeLessThan(Math.min(...isometric));
    expect(isometric.length).toBeLessThan(perspective.length);
    // Close in, the isometric view refines everything it shows.
    expect(Math.min(...levels(requests(view(1, 40))))).toBe(0);
  });
});

describe("returning from an isometric view", () => {
  function serve(): void {
    const empty = new Uint32Array(0);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const [level, x, z] = new URL(String(input), "http://localhost").pathname
          .split("/")
          .slice(2)
          .map(Number) as [number, number, number];
        const size = regionGridSize(level) ** 2;
        const bytes = encodeSceneRegion({
          level,
          x,
          z,
          // Flat low ground: lower than the typical terrain assumed before a region arrives.
          minY: 60,
          maxY: 62,
          heights: new Int16Array(size).fill(EMPTY_HEIGHT),
          opaque: empty,
          plants: empty,
          translucent: empty,
        });
        return Promise.resolve(new Response(new Uint8Array(bytes).buffer));
      }),
    );
  }

  async function settle(streamer: RegionStreamer, camera: PerspectiveCamera): Promise<void> {
    for (let step = 0; step < 200; step += 1) {
      streamer.update(camera, 600);
      const { loading, remaining } = streamer.stats;
      if (loading === 0 && remaining === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    streamer.update(camera, 600);
  }

  function camera(blend: number): ViewCamera {
    const view = new ViewCamera(50, 1.5, 1, 6000);
    view.position.set(0, 64 + 200 * Math.sin(0.42), 200 * Math.cos(0.42));
    view.lookAt(0, 64, 0);
    view.updateMatrixWorld();
    view.projectionBlend = blend;
    view.focusDistance = 200;
    view.updateProjectionMatrix();
    return view;
  }

  const drawn = (streamer: RegionStreamer) =>
    [...(Reflect.get(streamer, "drawn") as Map<string, unknown>).keys()].sort();

  it("draws the same regions as a view opened directly in perspective", async () => {
    serve();
    const options = { viewDistance: 1800, maxRequests: 64, memoryBudget: 1 << 30 };
    const direct = stream("overworld", options);
    await settle(direct, camera(0));
    const expected = drawn(direct);
    direct.dispose();

    const roundTrip = stream("overworld", options);
    await settle(roundTrip, camera(1));
    const isometric = drawn(roundTrip);
    await settle(roundTrip, camera(0));
    expect(isometric).not.toEqual(expected);
    expect(drawn(roundTrip)).toEqual(expected);
    roundTrip.dispose();
  });
});
