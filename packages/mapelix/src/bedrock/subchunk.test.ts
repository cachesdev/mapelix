import { describe, expect, it } from "vitest";

import { SUBCHUNK_TAG } from "./chunk-key.js";
import { decodeSubchunk } from "./subchunk.js";

const blockCount = 4096;

function keyFor(y: number, dimension?: number): Uint8Array {
  const key = new Uint8Array(dimension === undefined ? 10 : 14);
  const view = new DataView(key.buffer);
  view.setInt32(0, 4, true);
  view.setInt32(4, -7, true);
  const tagOffset = dimension === undefined ? 8 : 12;
  if (dimension !== undefined) {
    view.setInt32(8, dimension, true);
  }
  key[tagOffset] = SUBCHUNK_TAG;
  key[tagOffset + 1] = y & 0xff;
  return key;
}

function paletteEntry(name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const entry = new Uint8Array(13 + nameBytes.length);
  const view = new DataView(entry.buffer);
  let offset = 0;
  entry[offset++] = 10;
  view.setUint16(offset, 0, true);
  offset += 2;
  entry[offset++] = 8;
  view.setUint16(offset, 4, true);
  offset += 2;
  entry.set(new TextEncoder().encode("name"), offset);
  offset += 4;
  view.setUint16(offset, nameBytes.length, true);
  offset += 2;
  entry.set(nameBytes, offset);
  offset += nameBytes.length;
  entry[offset] = 0;
  return entry;
}

function storage(
  bitsPerBlock: number,
  indexes: readonly number[],
  names: readonly string[],
): Uint8Array {
  const blocksPerWord = Math.floor(32 / bitsPerBlock);
  const words = new Uint32Array(Math.ceil(blockCount / blocksPerWord));
  for (let index = 0; index < blockCount; index += 1) {
    const paletteIndex = indexes[index] ?? 0;
    const word = Math.floor(index / blocksPerWord);
    words[word] = (words[word] ?? 0) | (paletteIndex << ((index % blocksPerWord) * bitsPerBlock));
  }
  const entries = names.map(paletteEntry);
  const size =
    1 + words.byteLength + 4 + entries.reduce((total, entry) => total + entry.byteLength, 0);
  const result = new Uint8Array(size);
  const view = new DataView(result.buffer);
  result[0] = bitsPerBlock << 1;
  for (let index = 0; index < words.length; index += 1) {
    view.setUint32(1 + index * 4, words[index] ?? 0, true);
  }
  let offset = 1 + words.byteLength;
  view.setUint32(offset, entries.length, true);
  offset += 4;
  for (const entry of entries) {
    result.set(entry, offset);
    offset += entry.byteLength;
  }
  return result;
}

function constantStorage(name: string): Uint8Array {
  return new Uint8Array([0, ...paletteEntry(name)]);
}

describe("decodeSubchunk", () => {
  it("decodes v8 primary packed indexes and palette names", () => {
    const indexes = Array.from({ length: blockCount }, () => 0);
    indexes[0] = 1;
    indexes[15] = 1;
    const primary = storage(2, indexes, ["minecraft:air", "stone"]);
    const value = new Uint8Array(2 + primary.byteLength);
    value.set([8, 1]);
    value.set(primary, 2);

    const decoded = decodeSubchunk(keyFor(-2), value);

    expect(decoded).toMatchObject({ version: 8, y: -2, key: { x: 4, z: -7, dimension: 0 } });
    expect(decoded?.primary.bitsPerBlock).toBe(2);
    expect(decoded?.primary.palette).toEqual(["minecraft:air", "minecraft:stone"]);
    expect(decoded?.primary.indexes[0]).toBe(1);
    expect(decoded?.primary.indexes[1]).toBe(0);
    expect(decoded?.primary.indexes[15]).toBe(1);
  });

  it("uses v9's signed subchunk Y and accepts an explicit dimension", () => {
    const constant = constantStorage("minecraft:air");
    const value = new Uint8Array(3 + constant.byteLength);
    value.set([9, 1, 0xfc]);
    value.set(constant, 3);
    const decoded = decodeSubchunk(keyFor(-4, 1), value);

    expect(decoded).toMatchObject({ version: 9, y: -4, key: { dimension: 1, y: -4 } });
    expect(decoded?.primary).toMatchObject({ bitsPerBlock: 0, palette: ["minecraft:air"] });
    expect(decoded?.primary.indexes).toHaveLength(blockCount);
  });

  it("decodes a zero-bit auxiliary storage's implicit one-entry palette", () => {
    const primary = storage(2, [], ["minecraft:air"]);
    const auxiliary = constantStorage("minecraft:water");
    const value = new Uint8Array(3 + primary.byteLength + auxiliary.byteLength);
    value.set([9, 2, 0xfc]);
    value.set(primary, 3);
    value.set(auxiliary, 3 + primary.byteLength);

    const decoded = decodeSubchunk(keyFor(-4), value);

    expect(decoded?.storages[1]).toMatchObject({
      bitsPerBlock: 0,
      palette: ["minecraft:water"],
    });
    expect(decoded?.storages[1]?.indexes).toEqual(new Uint16Array(blockCount));
  });

  it("reports unsupported versions clearly", () => {
    expect(() => decodeSubchunk(keyFor(0), new Uint8Array([1]))).toThrow(
      "Unsupported Bedrock subchunk version 1; only v8 and v9 are supported",
    );
  });

  it("ignores values whose keys are not subchunks", () => {
    const key = keyFor(0);
    key[8] = 0x2e;
    expect(decodeSubchunk(key, new Uint8Array([1]))).toBeUndefined();
  });
});
