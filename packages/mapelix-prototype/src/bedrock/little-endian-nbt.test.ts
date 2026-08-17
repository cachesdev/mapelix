import { describe, expect, it } from "vitest";

import { blockNameFromPaletteEntry, readLittleEndianNbtCompound } from "./little-endian-nbt.js";

function paletteEntry(name: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const result = new Uint8Array(1 + 2 + 1 + 2 + 4 + 2 + nameBytes.length + 1);
  const view = new DataView(result.buffer);
  let offset = 0;
  result[offset++] = 10; // root compound
  view.setUint16(offset, 0, true); // root name
  offset += 2;
  result[offset++] = 8; // string tag
  view.setUint16(offset, 4, true);
  offset += 2;
  result.set(new TextEncoder().encode("name"), offset);
  offset += 4;
  view.setUint16(offset, nameBytes.length, true);
  offset += 2;
  result.set(nameBytes, offset);
  offset += nameBytes.length;
  result[offset] = 0; // compound end
  return result;
}

describe("readLittleEndianNbtCompound", () => {
  it("reads palette compounds and returns a namespaced block name", () => {
    const bytes = paletteEntry("stone");
    const entry = readLittleEndianNbtCompound(bytes);

    expect(entry.nextOffset).toBe(bytes.length);
    expect(blockNameFromPaletteEntry(entry)).toBe("minecraft:stone");
  });

  it("preserves an existing namespace", () => {
    expect(blockNameFromPaletteEntry(readLittleEndianNbtCompound(paletteEntry("mod:block")))).toBe(
      "mod:block",
    );
  });

  it("reports malformed roots clearly", () => {
    expect(() => readLittleEndianNbtCompound(new Uint8Array([8, 0, 0]))).toThrow(
      "expected compound root",
    );
  });
});
