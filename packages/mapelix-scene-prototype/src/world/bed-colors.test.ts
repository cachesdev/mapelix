import { describe, expect, it } from "vitest";
import { bedEntityRecord, chunkKey } from "../../test/dimension-fixture.js";
import { isBlockEntityKey, readBedColors, readBannerColors } from "./bed-colors.js";

describe("bed block-entity colors", () => {
  it("reads all banner Base dyes without mixing beds, foreign cells or malformed metadata", () => {
    const entries = Array.from({ length: 16 }, (_, base) => ({
      id: "Banner",
      x: -16 + base,
      y: 70,
      z: 0,
      base,
    }));
    const bytes = bedEntityRecord(0, -1, 0, [
      ...entries,
      { id: "Banner", x: -16, y: 70, z: 1, base: 16 },
      { id: "Banner", x: 0, y: 70, z: 0, base: 0 },
      { id: "Banner", x: -16, y: 320, z: 0, base: 0 },
      { id: "Bed", x: -16, y: 70, z: 2, color: 14 },
    ]).value;
    const colors = readBannerColors(new Uint8Array([...bytes, 10]), -1, 0, -64, 320);
    expect(colors.get(4)?.size).toBe(16);
    for (let base = 0; base < 16; base++)
      expect(colors.get(4)?.get((base << 8) | 6)).toBe(15 - base);
    expect(readBedColors(bytes, -1, 0, -64, 320).get(4)?.size).toBe(1);
    expect(readBannerColors(undefined, -1, 0, -64, 320).size).toBe(0);
  });
  it("isolates dimensions and ignores other terrain record types", () => {
    expect(isBlockEntityKey(chunkKey(0, -1, 2, 0x31), 0)).toBe(true);
    expect(isBlockEntityKey(chunkKey(1, -1, 2, 0x31), 1)).toBe(true);
    expect(isBlockEntityKey(chunkKey(1, -1, 2, 0x31), 0)).toBe(false);
    expect(isBlockEntityKey(chunkKey(0, -1, 2, 0x2b), 0)).toBe(false);
    expect(isBlockEntityKey(new Uint8Array(), 0)).toBe(false);
  });

  it("keeps separate bed colors in the same section, including negative coordinates", () => {
    const record = bedEntityRecord(0, -1, 0, [
      { x: -16, y: -1, z: 0, color: 14 },
      { x: -1, y: -1, z: 1, color: 0 },
    ]);
    const colors = readBedColors(record.value, -1, 0, -64, 320);
    expect(colors.get(-1)?.get(15)).toBe(14);
    expect(colors.get(-1)?.get((15 << 8) | (1 << 4) | 15)).toBe(0);
  });

  it("rejects non-bed entities, invalid dyes, foreign chunks and out-of-range heights", () => {
    const beds = [
      { x: 0, y: 70, z: 0, color: 3, id: "Chest" },
      { x: 1, y: 70, z: 0, color: 16 },
      { x: 2, y: 70, z: 0, color: -1 },
      { x: 16, y: 70, z: 0, color: 1 },
      { x: 0, y: 128, z: 1, color: 2 },
      { x: 0, y: -1, z: 2, color: 2 },
      { x: 0, y: 70, z: 3 },
    ];
    expect(readBedColors(bedEntityRecord(1, 0, 0, beds).value, 0, 0, 0, 128).size).toBe(0);
  });

  it("does not let missing or malformed optional metadata prevent terrain loading", () => {
    expect(readBedColors(undefined, 0, 0, -64, 320).size).toBe(0);
    expect(readBedColors(new Uint8Array([10]), 0, 0, -64, 320).size).toBe(0);
    const valid = bedEntityRecord(0, 0, 0, [{ x: 0, y: 70, z: 0, color: 14 }]).value;
    const corruptTail = new Uint8Array([...valid, 10]);
    expect(readBedColors(corruptTail, 0, 0, -64, 320).get(4)?.get(6)).toBe(14);
  });
});
