import { describe, expect, it } from "vitest";

import { SUBCHUNK_TAG, classifyChunkKey } from "./chunk-key.js";

function subchunkKey(x: number, z: number, y: number, dimension?: number): Uint8Array {
  const key = new Uint8Array(dimension === undefined ? 10 : 14);
  const view = new DataView(key.buffer);
  view.setInt32(0, x, true);
  view.setInt32(4, z, true);
  const tagOffset = dimension === undefined ? 8 : 12;
  if (dimension !== undefined) {
    view.setInt32(8, dimension, true);
  }
  key[tagOffset] = SUBCHUNK_TAG;
  key[tagOffset + 1] = y & 0xff;
  return key;
}

describe("classifyChunkKey", () => {
  it("decodes an overworld subchunk key and its signed Y", () => {
    expect(classifyChunkKey(subchunkKey(-12, 34, -1))).toEqual({
      tag: SUBCHUNK_TAG,
      x: -12,
      z: 34,
      dimension: 0,
      y: -1,
    });
  });

  it("decodes an explicitly dimensioned subchunk key", () => {
    expect(classifyChunkKey(subchunkKey(9, -8, -32, 2))).toEqual({
      tag: SUBCHUNK_TAG,
      x: 9,
      z: -8,
      dimension: 2,
      y: -32,
    });
  });

  it("does not classify other record types or malformed lengths", () => {
    const notSubchunk = subchunkKey(0, 0, 0);
    notSubchunk[8] = 0x2e;

    expect(classifyChunkKey(notSubchunk)).toBeUndefined();
    expect(classifyChunkKey(new Uint8Array(11))).toBeUndefined();
  });
});
