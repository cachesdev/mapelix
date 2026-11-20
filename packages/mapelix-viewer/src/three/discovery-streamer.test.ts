import { afterEach, describe, expect, it, vi } from "vitest";
import { PerspectiveCamera, Vector3 } from "three/webgpu";
import {
  DEFAULT_DISCOVERY_FILTERS,
  encodeDiscoveryTile,
  packDiscoveryBlock,
} from "@mapelix/scene-prototype/discoveries";
import { DiscoveryStreamer, type DiscoveryOptions } from "./discovery-streamer";
import type { WorldInfo } from "./world-viewer";

class Element {
  style: Record<string, string> = {};
  children: Element[] = [];
  parent: Element | undefined;
  setAttribute() {}
  append(child: Element) {
    child.parent = this;
    this.children.push(child);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
    for (const child of children) child.parent = this;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 800, height: 600 };
  }
}
const world: WorldInfo = {
  name: "Fixture",
  dimension: "overworld",
  mode: "caves",
  minY: -64,
  maxY: -32,
  revision: "terrain-a",
  snapshotRevision: "snapshot-a",
  spawn: { x: 16, y: -48, z: 16 },
  discoveries: { schemaVersion: 1, tileSpan: 32 },
};
const camera = new PerspectiveCamera(50, 1, 1, 1000),
  focus = new Vector3(16, -48, 16);
camera.position.set(16, 20, 30);
camera.lookAt(focus);
camera.updateMatrixWorld();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
function setup(budget?: number, options: Partial<DiscoveryOptions> = {}) {
  vi.stubGlobal("document", { createElement: () => new Element() });
  const container = new Element();
  const stream = new DiscoveryStreamer(container as unknown as HTMLElement, {
    base: "/embedded/discoveries",
    suffix: ".bin",
    ...(budget === undefined ? {} : { memoryBudget: budget }),
    onselect: vi.fn(),
    ...options,
  });
  stream.setWorld(world);
  stream.setFilters({
    ...DEFAULT_DISCOVERY_FILTERS,
    enabled: true,
    categories: ["ores"],
    ores: ["diamond"],
  });
  return {
    stream,
    container,
    tick: (point = focus, ready = true) =>
      stream.update(camera, point, ready, container as unknown as HTMLElement),
  };
}
function response(url: string, indexed = true, exposure: "buried" | "exposed" = "buried") {
  const u = new URL(url, "http://localhost"),
    parts = u.pathname.split("/");
  const x = Number(parts.at(-2)),
    z = Number(parts.at(-1)!.replace(".bin", ""));
  const bytes = encodeDiscoveryTile({
    dimension: "overworld",
    x,
    z,
    sourceChunks: 15,
    blocks: indexed
      ? Uint32Array.from([packDiscoveryBlock(14, -63, 20, 6, exposure)])
      : new Uint32Array(),
  });
  return new Response(new Uint8Array(bytes).buffer);
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("discovery source reuse and lifecycle", () => {
  it("fails closed without exact terrain and recomputes cached sources while more terrain arrives", async () => {
    let known = false;
    const fetcher = vi.fn<typeof fetch>(async (url) => response(String(url), true, "exposed"));
    vi.stubGlobal("fetch", fetcher);
    const { stream, tick } = setup(undefined, { isSurfaceBlock: () => known });
    stream.setWorld({ ...world, mode: "surface", minY: -64, maxY: 320, ceilingY: 320 });
    stream.setSelection({ minX: 0, maxX: 32, minZ: 0, maxZ: 32 });
    tick();
    await flush();
    tick();
    expect(stream.stats.matchingBlocks).toBe(0);
    known = true;
    stream.setTerrainRevision(1);
    tick(focus, false);
    expect(stream.stats.matchingBlocks).toBe(1);
    expect(stream.isSurfaceDiscovery(stream.stats.groups[0]!)).toBe(true);
    known = false;
    stream.setTerrainRevision(2);
    tick(focus, false);
    expect(stream.stats.matchingBlocks).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
    stream.setFilters({
      ...DEFAULT_DISCOVERY_FILTERS,
      enabled: true,
      categories: ["ores"],
      ores: ["diamond"],
      allHeights: true,
    });
    tick();
    expect(stream.stats.matchingBlocks).toBe(1);
    stream.setTerrainRevision(3);
    expect(stream.stats.matchingBlocks).toBe(1);
    stream.dispose();
  });
  it("checks the selected voxel's exposure in a mixed group", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            new Uint8Array(
              encodeDiscoveryTile({
                dimension: "overworld",
                x: 0,
                z: 0,
                sourceChunks: 15,
                blocks: Uint32Array.of(
                  packDiscoveryBlock(14, -63, 20, 6, "buried"),
                  packDiscoveryBlock(15, -63, 20, 6, "exposed"),
                ),
              }),
            ).buffer,
          ),
      ),
    );
    const { stream, tick } = setup();
    stream.setSelection({ minX: 0, maxX: 32, minZ: 0, maxZ: 32 });
    tick();
    await flush();
    tick();
    const group = stream.stats.groups[0]!;
    expect(group).toMatchObject({ count: 2, exposed: 1, buried: 1 });
    expect(stream.isExposedDiscovery({ ...group, x: 14 })).toBe(false);
    expect(stream.isExposedDiscovery({ ...group, x: 15 })).toBe(true);
    stream.dispose();
  });
  it("does not restart grouping or requests when the host reapplies identical filters", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => response(String(url)));
    vi.stubGlobal("fetch", fetcher);
    const { stream, tick } = setup();
    stream.setSelection({ minX: 0, maxX: 32, minZ: 0, maxZ: 32 });
    tick();
    await flush();
    tick();
    expect(stream.stats.matchingBlocks).toBe(1);
    expect(
      stream.setFilters({
        ...DEFAULT_DISCOVERY_FILTERS,
        enabled: true,
        categories: ["ores"],
        ores: ["diamond"],
      }),
    ).toBe(false);
    tick();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(stream.stats.matchingBlocks).toBe(1);
    stream.dispose();
  });
  it("automatically retries transient discovery errors after Retry-After", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "4" } }))
      .mockImplementation(async (url) => response(String(url)));
    vi.stubGlobal("fetch", fetcher);
    const { stream, tick } = setup();
    stream.setSelection({ minX: 0, maxX: 32, minZ: 0, maxZ: 32 });
    tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(stream.stats.error).toContain("Server busy");
    tick();
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stream.stats.cached).toBe(1);
    expect(stream.stats.error).toBeUndefined();
    stream.dispose();
  });
  it("waits for terrain, reuses source indexes through depth/mesh changes and uses an embedded endpoint", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url) => response(String(url)));
    vi.stubGlobal("fetch", fetcher);
    const { stream, tick } = setup();
    stream.setSelection({ minX: 0, maxX: 32, minZ: 0, maxZ: 32 });
    tick(focus, false);
    expect(fetcher).not.toHaveBeenCalled();
    tick();
    await flush();
    tick();
    expect(stream.stats.matchingBlocks).toBe(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain("/embedded/discoveries/0/0.bin?");
    expect(String(fetcher.mock.calls[0]![0])).toContain("revision=snapshot-a");
    stream.setWorld({ ...world, minY: -32, maxY: 0, revision: "terrain-b" });
    tick();
    expect(stream.stats.matchingBlocks).toBe(0);
    expect(fetcher).toHaveBeenCalledOnce();
    stream.dispose();
  });
  it("bounds cached bytes and entries while exploring different source regions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => response(String(url), false)),
    );
    const { stream, tick, container } = setup(96);
    for (let index = 0; index < 15; index++) {
      tick(new Vector3(index * 100, -48, 16));
      await flush();
      expect(stream.stats.bytes).toBeLessThanOrEqual(96);
      expect(stream.stats.cached).toBeLessThanOrEqual(3);
    }
    stream.dispose();
    expect(container.children).toHaveLength(0);
    expect(stream.stats.bytes).toBe(0);
  });
  it("aborts old revisions, ignores late replies and does not request unsupported legacy sources", async () => {
    let resolve: ((value: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { stream, tick } = setup();
    tick();
    stream.setWorld({ ...world, snapshotRevision: "snapshot-b" });
    expect((fetcher.mock.calls[0]![1]!.signal as AbortSignal).aborted).toBe(true);
    resolve!(response(String(fetcher.mock.calls[0]![0])));
    await flush();
    expect(stream.stats.cached).toBe(0);
    const { discoveries: _capabilities, ...legacy } = world;
    stream.setWorld(legacy);
    tick();
    expect(fetcher).toHaveBeenCalledOnce();
    stream.dispose();
  });
});
