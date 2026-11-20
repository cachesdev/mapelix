import { describe, expect, it } from "vitest";
import { biomeRecord, sectionRecord, type FixtureRecord } from "../../test/dimension-fixture.js";
import { ChunkSource } from "./chunk-source.js";

function source(records: readonly FixtureRecord[], dimension: "overworld" | "nether" | "the-end") {
  return new ChunkSource(
    {
      readPrefix: (prefix) =>
        records.filter((record) => prefix.every((byte, index) => record.key[index] === byte)),
    },
    dimension,
  );
}

describe("dimension chunk decoding", () => {
  it("does not accept a v9 header outside the dimension even if its key is in bounds", () => {
    const record = sectionRecord(1, 0, 0, 0, "minecraft:netherrack");
    record.value[2] = 8;
    expect(source([record], "nether").chunk(0, 0)?.sections).toEqual([]);
  });
  it("reads each actual dimension key at the same negative chunk position without mixing caches", () => {
    const records = [
      sectionRecord(0, -2, 3, -4, "minecraft:stone"),
      sectionRecord(1, -2, 3, 0, "minecraft:netherrack"),
      sectionRecord(2, -2, 3, 0, "minecraft:end_stone"),
    ];
    for (const [dimension, name, y] of [
      ["overworld", "minecraft:stone", -4],
      ["nether", "minecraft:netherrack", 0],
      ["the-end", "minecraft:end_stone", 0],
    ] as const) {
      const chunks = source(records, dimension);
      const chunk = chunks.chunk(-2, 3);
      expect(chunk?.sections).toHaveLength(1);
      expect(chunk?.sections[0]?.y).toBe(y);
      expect(chunk?.sections[0]?.primary.palette).toEqual([name]);
      expect(chunks.chunk(-2, 3)).toBe(chunk);
      expect(chunks.chunk(0, 0)).toBeUndefined();
    }
  });

  it.each([
    ["overworld", 0, -4, 19],
    ["nether", 1, 0, 7],
    ["the-end", 2, 0, 15],
  ] as const)(
    "bounds %s records and starts biome storage at its floor",
    (dimension, id, bottom, top) => {
      const records = [bottom - 1, bottom, top, top + 1].map((y) =>
        sectionRecord(id, 0, 0, y, "minecraft:bedrock"),
      );
      records.push(
        biomeRecord(
          id,
          0,
          0,
          Array.from({ length: top - bottom + 1 }, (_, index) => 100 + index),
        ),
      );
      const chunk = source(records, dimension).chunk(0, 0);
      expect(chunk?.sections.map((section) => section.y)).toEqual([bottom, top]);
      expect(chunk?.biomes.at(0, bottom * 16, 0)).toBe(100);
      expect(chunk?.biomes.at(0, top * 16 + 15, 0)).toBe(100 + top - bottom);
      expect(chunk?.biomes.at(0, bottom * 16 - 1, 0)).toBeUndefined();
      expect(chunk?.biomes.at(0, (top + 1) * 16, 0)).toBeUndefined();
    },
  );
});
