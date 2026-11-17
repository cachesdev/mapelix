import { describe, expect, it } from "vitest";
import {
  ancestorSource,
  blockAt,
  levelFor,
  panBy,
  pinch,
  tileRect,
  tileSpan,
  visibleTiles,
  zoomAround,
  type MapView,
} from "./tile-math";
import { TileIndex, type PublishedTileManifest } from "./tile-index";
import { TapDetector, VelocityTracker, glide, wheelFactor } from "./map-input";

const ZOOMS = [-4, -3, -2, -1, 0, 1, 2];

describe("tile geometry", () => {
  it("picks the coarsest zoom that is never enlarged, then the finest one", () => {
    expect(levelFor(1, 1, ZOOMS)).toBe(0);
    expect(levelFor(1, 2, ZOOMS)).toBe(1);
    expect(levelFor(0.3, 1, ZOOMS)).toBe(-1);
    expect(levelFor(3, 1, ZOOMS)).toBe(2);
    expect(levelFor(16, 3, ZOOMS)).toBe(2);
    expect(levelFor(0.01, 1, ZOOMS)).toBe(-4);
  });

  it("covers the screen and lists the middle tiles first", () => {
    const view: MapView = { x: 10, z: -20, pixelsPerBlock: 1 };
    const tiles = visibleTiles(view, 800, 600, 0);
    // 800 × 600 blocks around (10, -20) touch tiles x -2..1 and y -2..1.
    expect(tiles).toHaveLength(16);
    expect(new Set(tiles.map((t) => t.x))).toEqual(new Set([-2, -1, 0, 1]));
    expect(tiles[0]).toEqual({ z: 0, x: 0, y: -1 });
    const distance = (t: { x: number; y: number }) =>
      (t.x + 0.5 - 10 / 256) ** 2 + (t.y + 0.5 + 20 / 256) ** 2;
    for (let i = 1; i < tiles.length; i += 1)
      expect(distance(tiles[i]!)).toBeGreaterThanOrEqual(distance(tiles[i - 1]!) - 1e-9);
    expect(visibleTiles(view, 800, 600, 0, 1)).toHaveLength(36);
  });

  it("rounds tile edges so neighbours share them at any scale and offset", () => {
    for (let trial = 0; trial < 500; trial += 1) {
      const view: MapView = {
        x: (Math.random() - 0.5) * 1e5,
        z: (Math.random() - 0.5) * 1e5,
        pixelsPerBlock: 2 ** (Math.random() * 9 - 5),
      };
      const ratio = [1, 1.5, 2, 2.625, 3][trial % 5]!;
      const zoom = levelFor(view.pixelsPerBlock, ratio, ZOOMS);
      const tiles = visibleTiles(view, 375, 812, zoom);
      const rects = new Map(
        tiles.map((t) => [`${t.x},${t.y}`, tileRect(view, 984, 2132, ratio, t)]),
      );
      for (const tile of tiles) {
        const rect = rects.get(`${tile.x},${tile.y}`)!;
        const east = rects.get(`${tile.x + 1},${tile.y}`);
        const south = rects.get(`${tile.x},${tile.y + 1}`);
        if (east) expect(east.left).toBe(rect.right);
        if (south) expect(south.top).toBe(rect.bottom);
      }
    }
  });

  it("keeps the block under the pointer while zooming, panning and pinching", () => {
    const view: MapView = { x: 100, z: 50, pixelsPerBlock: 2 };
    const before = blockAt(view, 400, 300, 50, 260);
    const zoomed = zoomAround(view, 7, 400, 300, 50, 260);
    expect(blockAt(zoomed, 400, 300, 50, 260).x).toBeCloseTo(before.x, 9);
    expect(blockAt(zoomed, 400, 300, 50, 260).z).toBeCloseTo(before.z, 9);
    expect(panBy(view, 20, -10)).toEqual({ x: 90, z: 55, pixelsPerBlock: 2 });

    const start = { x: 120, y: 80, distance: 100 };
    const now = { x: 200, y: 150, distance: 250 };
    const pinched = pinch(view, 400, 300, start, now, (s) => s);
    expect(pinched.pixelsPerBlock).toBeCloseTo(5, 9);
    const anchor = blockAt(view, 400, 300, start.x, start.y);
    const after = blockAt(pinched, 400, 300, now.x, now.y);
    expect(after.x).toBeCloseTo(anchor.x, 9);
    expect(after.z).toBeCloseTo(anchor.z, 9);
    expect(pinch(view, 400, 300, start, now, () => 3).pixelsPerBlock).toBe(3);
  });

  it("finds the part of an ancestor that covers a tile, including negative tiles", () => {
    expect(ancestorSource({ z: 2, x: -3, y: 5 }, 0)).toEqual({
      tile: { z: 0, x: -1, y: 1 },
      sx: 64,
      sy: 64,
      size: 64,
    });
    expect(tileSpan(-4)).toBe(4096);
  });
});

describe("tile index", () => {
  const manifest: PublishedTileManifest = {
    format: "mapelix-2d",
    schemaVersion: 1,
    generation: "g",
    tileBase: "generations/g/",
    grid: { tileSize: 256, zooms: [0, 1] },
    tiles: [
      { dimension: "overworld", z: 1, x: -2, y: 0, path: "overworld/tiles/1/-2/0.png" },
      { dimension: "overworld", z: 0, x: -1, y: 0, path: "overworld/tiles/0/-1/0.png" },
      { dimension: "nether", z: 0, x: 3, y: 3, path: "nether/tiles/0/3/3.png" },
    ],
  };

  it("lists dimensions, zooms, extents and resolves URLs against the manifest", () => {
    const index = new TileIndex(manifest, "https://maps.example/world/manifest.json");
    expect(index.dimensions).toEqual(["overworld", "nether"]);
    expect(index.zooms("overworld")).toEqual([0, 1]);
    expect(index.extent("overworld")).toEqual([-256, 0, 0, 256]);
    expect(index.url("overworld", { z: 0, x: -1, y: 0 })).toBe(
      "https://maps.example/world/generations/g/overworld/tiles/0/-1/0.png",
    );
    expect(index.url("overworld", { z: 0, x: 0, y: 0 })).toBeUndefined();
    expect(() => new TileIndex({ ...manifest, schemaVersion: 2 as 1 }, "https://x/")).toThrow();
  });
});

describe("map input", () => {
  it("measures fling speed and ignores a rest before release", () => {
    const tracker = new VelocityTracker();
    tracker.reset(0, 0, 0);
    for (let t = 10; t <= 200; t += 10) tracker.add(t, t * 2, -t);
    expect(tracker.velocity(205)).toEqual({ x: 2, y: -1 });
    expect(tracker.velocity(300)).toEqual({ x: 0, y: 0 });
  });

  it("glides a finite distance that sums the same in small or large steps", () => {
    let velocity = { x: 1, y: 0 },
      travelled = 0;
    for (let i = 0; i < 200; i += 1) {
      const step = glide(velocity, 16);
      travelled += step.dx;
      velocity = step.velocity;
    }
    expect(travelled).toBeCloseTo(glide({ x: 1, y: 0 }, 3200).dx, 6);
    expect(travelled).toBeLessThan(325);
  });

  it("zooms by about √2 per mouse notch, both ways", () => {
    expect(wheelFactor(-100, 0, false)).toBeCloseTo(Math.SQRT2, 9);
    expect(wheelFactor(100, 0, false) * wheelFactor(-100, 0, false)).toBeCloseTo(1, 9);
    expect(wheelFactor(-3, 1, false)).toBeGreaterThan(wheelFactor(-1, 1, false));
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
  });

  it("recognises a double tap only when quick and close", () => {
    const taps = new TapDetector();
    expect(taps.release(0, 80, 2, 100, 100)).toBe(false);
    expect(taps.release(200, 260, 1, 110, 105)).toBe(true);
    expect(taps.release(1000, 1080, 0, 100, 100)).toBe(false);
    expect(taps.release(1500, 1560, 0, 100, 100)).toBe(false);
    expect(taps.release(1700, 1760, 0, 200, 100)).toBe(false);
    expect(taps.release(1800, 2200, 0, 200, 100)).toBe(false);
  });
});
