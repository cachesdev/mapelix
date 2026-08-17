import { describe, expect, it } from "vitest";

import {
  DATA_2D_TAG,
  DATA_3D_TAG,
  SUBCHUNK_TAG,
  classifyChunkKey,
  classifyData2DKey,
  classifyData3DKey,
} from "./chunk-key.js";

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

describe("classifyData2DKey", () => {
  it("decodes overworld and dimensioned biome keys", () => {
    const overworld = subchunkKey(-4, 9, 0).slice(0, 9);
    overworld[8] = DATA_2D_TAG;
    expect(classifyData2DKey(overworld)).toEqual({
      tag: DATA_2D_TAG,
      x: -4,
      z: 9,
      dimension: 0,
    });

    const dimensioned = subchunkKey(2, 3, 0, 7).slice(0, 13);
    dimensioned[12] = DATA_2D_TAG;
    expect(classifyData2DKey(dimensioned)).toEqual({
      tag: DATA_2D_TAG,
      x: 2,
      z: 3,
      dimension: 7,
    });
  });
});

describe("classifyData3DKey", () => {
  it("decodes overworld and dimensioned biome keys", () => {
    const overworld = subchunkKey(-7, 11, 0).slice(0, 9);
    overworld[8] = DATA_3D_TAG;
    expect(classifyData3DKey(overworld)).toEqual({
      tag: DATA_3D_TAG,
      x: -7,
      z: 11,
      dimension: 0,
    });

    const dimensioned = subchunkKey(5, -6, 0, 3).slice(0, 13);
    dimensioned[12] = DATA_3D_TAG;
    expect(classifyData3DKey(dimensioned)).toEqual({
      tag: DATA_3D_TAG,
      x: 5,
      z: -6,
      dimension: 3,
    });
  });
});
