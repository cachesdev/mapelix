import { describe, expect, it } from "vitest";

import { DATA_2D_TAG } from "./chunk-key.js";
import { data2DBiomeAt, decodeData2D } from "./data-2d.js";

function int32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

describe("decodeData2D", () => {
  it("decodes signed heights and Z-major 8-bit biomes", () => {
    const value = new Uint8Array(768);
    const view = new DataView(value.buffer);
    view.setInt16((3 * 16 + 7) * 2, -12, true);
    value[512 + 7 * 16 + 3] = 42;

    const decoded = decodeData2D(new Uint8Array([...int32(-1), ...int32(2), DATA_2D_TAG]), value);
    expect(decoded?.heights[3 * 16 + 7]).toBe(-12);
    expect(decoded === undefined ? undefined : data2DBiomeAt(decoded, 3, 7)).toBe(42);
  });

  it("accepts 16-bit biome identifiers", () => {
    const value = new Uint8Array(1024);
    new DataView(value.buffer).setUint16(512 + (5 * 16 + 4) * 2, 513, true);
    const decoded = decodeData2D(new Uint8Array([...int32(0), ...int32(0), DATA_2D_TAG]), value);
    expect(decoded === undefined ? undefined : data2DBiomeAt(decoded, 4, 5)).toBe(513);
  });
});
