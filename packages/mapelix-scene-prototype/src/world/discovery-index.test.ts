import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { decodeDiscoveryTile, discoveryKind, unpackDiscoveryBlock } from "../discoveries.js";
import { RegionBuilder } from "../node/region-builder.js";

describe("discovery extraction from source records", () => {
  let directory: string;
  const builders: RegionBuilder[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-discoveries-"));
    await writeFixtureWorld(
      directory,
      [0, 1, 2].map((dimension) =>
        sectionRecord(dimension, -1, 0, dimension === 0 ? -3 : 2, (x, y, z) => {
          const height = dimension === 0 ? -40 : 40;
          if (y === height && z === 8) {
            if (x === -8) return "minecraft:coal_ore";
            if (x === -6) return "minecraft:diamond_ore";
            if (x === -1) return "minecraft:ancient_debris";
            if (x === -10) return "minecraft:mob_spawner";
            if (x === -12) return "minecraft:chest";
          }
          if (y === height + 1 && z === 8 && x === -6) return "minecraft:air";
          return "minecraft:stone";
        }),
      ),
    );
    for (const dimension of ["overworld", "nether", "the-end"] as const)
      builders.push(new RegionBuilder({ directory, dimension }));
  });
  afterAll(async () => {
    for (const builder of builders) builder.close();
    await rm(directory, { recursive: true, force: true });
  });
  it.each([0, 1, 2])(
    "indexes exposed, fully buried and boundary-unknown blocks in dimension %i",
    (dimension) => {
      const bytes = builders[dimension]!.discoveries({ x: -1, z: 0 });
      const tile = decodeDiscoveryTile(bytes),
        blocks = Array.from(tile.blocks, (word) => unpackDiscoveryBlock(tile, word));
      expect(tile.sourceChunks).toBe(2);
      expect(blocks).toHaveLength(5);
      expect(
        blocks.find((block) => block.kind === discoveryKind("minecraft:coal_ore"))?.exposure,
      ).toBe("buried");
      expect(
        blocks.find((block) => block.kind === discoveryKind("minecraft:diamond_ore"))?.exposure,
      ).toBe("exposed");
      expect(
        blocks.find((block) => block.kind === discoveryKind("minecraft:ancient_debris"))?.exposure,
      ).toBe("unknown");
      expect(blocks.find((block) => block.kind === discoveryKind("minecraft:chest"))?.x).toBe(-12);
      expect(builders[dimension]!.discoveries({ x: -1, z: 0 })).toEqual(bytes);
      expect(
        decodeDiscoveryTile(builders[dimension]!.discoveries({ x: 100, z: 100 })).sourceChunks,
      ).toBe(0);
    },
  );
  it("does not change shared terrain builder output after all-height indexing", () => {
    const builder = builders[0]!,
      request = { level: 0, x: -1, z: 0 };
    const before = builder.build(request);
    builder.discoveries({ x: -1, z: 0 });
    builder.build({ ...request, mode: "caves", minY: -48, maxY: -16 });
    expect(builder.build(request)).toEqual(before);
  });
});
