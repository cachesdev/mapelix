import { describe, expect, it } from "vitest";

import { DATA_3D_TAG } from "./chunk-key.js";
import { data3DBiomeAt, decodeData3D } from "./data-3d.js";

function int32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function packedStorage(bits: number, palette: readonly number[], changedIndex?: number): number[] {
  const biomesPerWord = Math.floor(32 / bits);
  const words = new Uint32Array(Math.ceil(4096 / biomesPerWord));
  if (changedIndex !== undefined) {
    const wordIndex = Math.floor(changedIndex / biomesPerWord);
    const shift = (changedIndex % biomesPerWord) * bits;
    words[wordIndex] = 1 << shift;
  }
  return [
    (bits << 1) | 1,
    ...new Uint8Array(words.buffer),
    ...int32(palette.length),
    ...palette.flatMap(int32),
  ];
}

function data3DValue(sectionSix: readonly number[]): Uint8Array {
  const sections = [1, ...int32(12), ...sectionSix, 0xff, 0xff];
  return new Uint8Array(512 + sections.length).map((_, index) =>
    index < 512 ? 0 : sections[index - 512]!,
  );
}

describe("decodeData3D", () => {
  it("decodes fixed and packed palettes in X/Z/Y order across negative section slots", () => {
    const localX = 3;
    const localZ = 7;
    const localY = 11;
    const changedIndex = localX * 256 + localZ * 16 + localY;
    const key = new Uint8Array([...int32(-8), ...int32(9), DATA_3D_TAG]);
    const decoded = decodeData3D(key, data3DValue(packedStorage(1, [1, 29], changedIndex)));

    expect(decoded?.key).toEqual({ tag: DATA_3D_TAG, x: -8, z: 9, dimension: 0 });
    const sectionYs = [-4, 6];
    expect(data3DBiomeAt(decoded!, sectionYs, 0, -64, 0)).toBe(12);
    expect(data3DBiomeAt(decoded!, sectionYs, localX, 6 * 16 + localY, localZ)).toBe(29);
    expect(data3DBiomeAt(decoded!, sectionYs, localZ, 6 * 16 + localY, localX)).toBe(1);
    expect(data3DBiomeAt(decoded!, sectionYs, localX, 5 * 16 + localY, localZ)).toBeUndefined();
  });

  it("rejects a palette index outside its palette", () => {
    const invalid = packedStorage(2, [1]);
    invalid[1] = 1;
    const key = new Uint8Array([...int32(0), ...int32(0), DATA_3D_TAG]);

    expect(() => decodeData3D(key, data3DValue(invalid))).toThrow(
      "packed palette index 1 is outside palette length 1",
    );
  });
});
