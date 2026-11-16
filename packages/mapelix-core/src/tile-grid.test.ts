import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAP_ZOOMS,
  mapPixelsPerBlock,
  mapTileAncestor,
  mapTileBounds,
} from "./tile-grid.js";
import type { Dimension } from "./types.js";

describe("overview XYZ grid", () => {
  it("defaults to -4..+2 and preserves explicit native +3 compatibility", () => {
    expect(DEFAULT_MAP_ZOOMS).toEqual([-4, -3, -2, -1, 0, 1, 2]);
    expect(mapPixelsPerBlock(-4)).toBe(1 / 16);
    expect(mapPixelsPerBlock(-1)).toBe(1 / 2);
    expect(mapPixelsPerBlock(2)).toBe(4);
    expect(mapPixelsPerBlock(3)).toBe(8);
  });

  it.each([-5, 4, 1.5, Infinity, NaN])("rejects unsupported zoom %s", (zoom) => {
    expect(() => mapPixelsPerBlock(zoom)).toThrow(RangeError);
  });

  it.each([-4, -1, 0, 2])("keeps adjacent negative and positive bounds exact at zoom %i", (z) => {
    const left = mapTileBounds({ dimension: "overworld", z, x: -1, y: -1 });
    const right = mapTileBounds({ dimension: "overworld", z, x: 0, y: -1 });
    const below = mapTileBounds({ dimension: "overworld", z, x: -1, y: 0 });
    expect(left.maxX).toBe(right.minX);
    expect(left.maxZ).toBe(below.minZ);
    expect(left.minX).toBe(-256 * 2 ** -z);
    expect(right.minX).toBe(0);
  });

  it("uses floor parents around zero and exact tile boundaries", () => {
    const tile = (x: number, y: number) => ({ dimension: "nether" as const, z: 0, x, y });
    expect(mapTileAncestor(tile(-1, -17), -4)).toEqual({
      dimension: "nether",
      z: -4,
      x: -1,
      y: -2,
    });
    expect(mapTileAncestor(tile(-16, -16), -4)).toMatchObject({ x: -1, y: -1 });
    expect(mapTileAncestor(tile(15, 16), -4)).toMatchObject({ x: 0, y: 1 });
    expect(() => mapTileAncestor(tile(0, 0), 1)).toThrow("finer");
  });

  it("refuses unsafe coordinates and unknown dimensions", () => {
    expect(() =>
      mapTileBounds({ dimension: "overworld", z: -4, x: Number.MAX_SAFE_INTEGER, y: 0 }),
    ).toThrow("safe integer");
    expect(() => mapTileBounds({ dimension: "end" as Dimension, z: -1, x: 0, y: 0 })).toThrow(
      "dimension",
    );
  });
});
