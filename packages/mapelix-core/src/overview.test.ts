import { describe, expect, it } from "vitest";

import { OverviewAccumulator, type OverviewSourceTile } from "./overview.js";
import type { TileCoordinates } from "./types.js";

const coordinates = { dimension: "overworld" as const, z: -1, x: 0, y: 0 };
const source = (
  rgba: Uint8Array = new Uint8Array(256 * 256 * 4),
  x = 0,
  y = 0,
): OverviewSourceTile => ({ coordinates: { ...coordinates, z: 0, x, y }, rgba });
const pixel = (rgba: Uint8Array, x = 0, y = 0) =>
  Array.from(rgba.slice((y * 256 + x) * 4, (y * 256 + x + 1) * 4));

function colorAt(x: number, z: number): number[] {
  return [
    (x + 80) & 255,
    (z + 120) & 255,
    (x ^ z) & 255,
    (x + z) % 7 === 0 ? 0 : (x & 1) === 0 ? 128 : 255,
  ];
}

function patternedSource(x: number, y: number): OverviewSourceTile {
  const tile = source(undefined, x, y);
  for (let z = 0; z < 256; z++)
    for (let column = 0; column < 256; column++)
      tile.rgba.set(colorAt(x * 256 + column, y * 256 + z), (z * 256 + column) * 4);
  return tile;
}

describe("alpha-weighted overview area filtering", () => {
  it("keeps holes transparent and ignores hidden RGB when averaging partial coverage", () => {
    const tile = source();
    tile.rgba.set([240, 120, 60, 255], 0);
    tile.rgba.set([0, 0, 255, 0], 4);
    tile.rgba.set([0, 200, 0, 128], 256 * 4);
    tile.rgba.set([255, 255, 255, 0], 257 * 4);
    const overview = new OverviewAccumulator(coordinates);
    overview.add(tile);
    const rgba = overview.finish();
    expect(pixel(rgba)).toEqual([160, 147, 40, 96]);
    expect(pixel(rgba, 1)).toEqual([0, 0, 0, 0]);
    expect(pixel(rgba, 200, 200)).toEqual([0, 0, 0, 0]);
  });

  it.each([-4, -3, -2, -1])(
    "retains a thin opaque feature at zoom %i without a dark fringe",
    (z) => {
      const overview = new OverviewAccumulator({ ...coordinates, z });
      const tile = source();
      tile.rgba.set([200, 100, 50, 255]);
      overview.add(tile);
      expect(pixel(overview.finish())).toEqual([200, 100, 50, Math.round(255 / 4 ** -z)]);
    },
  );

  it("rounds only once for a sub-half-alpha footprint at -4", () => {
    const overview = new OverviewAccumulator({ ...coordinates, z: -4 });
    const tile = source();
    for (let index = 0; index < 127; index++)
      tile.rgba.set([220, 80, 20, 1], (Math.floor(index / 16) * 256 + (index % 16)) * 4);
    overview.add(tile);
    expect(pixel(overview.finish())).toEqual([0, 0, 0, 0]);
  });

  it("handles all 256 source tiles at -4 without overflowing its integer sums", () => {
    const overview = new OverviewAccumulator({ ...coordinates, z: -4, x: -1, y: -1 });
    const rgba = source().rgba;
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([255, 254, 253, 255], offset);
    for (let y = -16; y < 0; y++) for (let x = -16; x < 0; x++) overview.add(source(rgba, x, y));
    const result = overview.finish();
    const expected = [255, 254, 253, 255];
    expect(result.every((value, index) => value === expected[index % 4])).toBe(true);
  });

  it.each([-4, -1])("matches an independent world-space area oracle across seams at %i", (z) => {
    const sources = [-1, 0].flatMap((y) => [-1, 0].map((x) => patternedSource(x, y)));
    const positions = [0, 1, 15, 16, 127, 128, 239, 240, 254, 255];
    const scale = 2 ** -z;
    for (const y of [-1, 0])
      for (const x of [-1, 0]) {
        const overview = new OverviewAccumulator({ ...coordinates, z, x, y });
        overview.add(sources.find((tile) => tile.coordinates.x === x && tile.coordinates.y === y)!);
        const actual = overview.finish();
        for (const py of positions)
          for (const px of positions) {
            const sums = [0, 0, 0, 0];
            for (let dz = 0; dz < scale; dz++)
              for (let dx = 0; dx < scale; dx++) {
                const wx = (x * 256 + px) * scale + dx;
                const wz = (y * 256 + py) * scale + dz;
                if (wx < -256 || wx >= 256 || wz < -256 || wz >= 256) continue;
                const value = colorAt(wx, wz);
                for (let channel = 0; channel < 3; channel++)
                  sums[channel] = sums[channel]! + value[channel]! * value[3]!;
                sums[3] = sums[3]! + value[3]!;
              }
            const alpha = Math.floor(sums[3]! / (scale * scale) + 0.5);
            const expected =
              alpha === 0
                ? [0, 0, 0, 0]
                : [...sums.slice(0, 3).map((value) => Math.floor(value / sums[3]! + 0.5)), alpha];
            expect(pixel(actual, px, py), `tile ${x}/${y}, pixel ${px}/${py}`).toEqual(expected);
          }
      }
  });

  it("rejects misplaced, duplicate and invalid sources", () => {
    const overview = new OverviewAccumulator(coordinates);
    overview.add(source());
    expect(() => overview.add(source())).toThrow("Duplicate");
    expect(() => overview.add(source(undefined, -1))).toThrow("outside");
    expect(() =>
      overview.add({ ...source(), coordinates: { ...coordinates, dimension: "nether", z: 0 } }),
    ).toThrow("dimension");
    expect(() => overview.add({ ...source(), coordinates })).toThrow("zoom-0");
    expect(() => overview.add(source(new Uint8Array(4), 1))).toThrow("256px");
    expect(() => new OverviewAccumulator({ ...coordinates, z: 0 })).toThrow(RangeError);
    expect(() => new OverviewAccumulator({ ...coordinates, z: -5 } as TileCoordinates)).toThrow(
      RangeError,
    );
  });
});
