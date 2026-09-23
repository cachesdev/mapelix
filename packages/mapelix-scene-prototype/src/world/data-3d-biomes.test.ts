import { describe, expect, it } from "vitest";

import { Data3DBiomes } from "./data-3d-biomes.js";

describe("Data3D biome reader", () => {
  it("reads single-biome, packed, and repeated storages by world height", () => {
    const bytes: number[] = Array.from({ length: 512 }, () => 0);
    const int32 = (value: number) => {
      const view = new DataView(new ArrayBuffer(4));
      view.setInt32(0, value, true);
      bytes.push(...new Uint8Array(view.buffer));
    };

    // y -64 to -49: one biome for the whole subchunk.
    bytes.push(0b1);
    int32(7);
    // y -48 to -33: one bit per voxel, with only local (2, 5, 3) set.
    bytes.push((1 << 1) | 1);
    const words = new Uint32Array(128);
    const voxel = 2 * 256 + 3 * 16 + 5;
    words[voxel >> 5] = 1 << (voxel & 31);
    for (const word of words) int32(word);
    int32(2);
    int32(1);
    int32(40);
    // y -32 to -17: the same storage as the subchunk below.
    bytes.push(0xff);

    const biomes = new Data3DBiomes(new Uint8Array(bytes));

    expect(biomes.at(9, -60, 4)).toBe(7);
    expect(biomes.at(2, -43, 3)).toBe(40);
    expect(biomes.at(2, -44, 3)).toBe(1);
    expect(biomes.at(2, -27, 3)).toBe(40);
    expect(biomes.at(0, 0, 0)).toBeUndefined();
  });
});
