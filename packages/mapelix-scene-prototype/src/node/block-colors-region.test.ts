import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { Face, QuadMaterial, decodeSceneRegion, unpackQuad } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

describe("sampled colors through all dimension meshers", () => {
  let directory: string;
  const builders: RegionBuilder[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-block-colors-"));
    const blocks = ["nether_gold_ore", "quartz_ore", "bone_block"];
    const records = [0, 1, 2].flatMap((dimension) =>
      blocks.map((block, x) => sectionRecord(dimension, x, 0, 4, `minecraft:${block}`)),
    );
    await writeFixtureWorld(directory, records);
    for (const dimension of ["overworld", "nether", "the-end"] as const) {
      builders.push(new RegionBuilder({ directory, dimension }));
    }
  });
  afterAll(async () => {
    for (const builder of builders) builder.close();
    await rm(directory, { recursive: true, force: true });
  });
  it.each([0, 1, 2].flatMap((dimension) => [0, 1, 2, 3, 4, 5].map((level) => [dimension, level])))(
    "preserves ore hosts and bone ends in dimension %i at LOD %i",
    (dimension, level) => {
      const region = decodeSceneRegion(builders[dimension!]!.build({ level: level!, x: 0, z: 0 }));
      const topColors = new Set<number>();
      for (let index = 0; index < region.opaque.length / 3; index++) {
        const quad = unpackQuad(region.opaque, index);
        if (quad.face === Face.PositiveY && quad.material === QuadMaterial.Solid) {
          topColors.add(quad.color);
        }
      }
      expect([...topColors].sort((a, b) => a - b)).toEqual([0x73372a, 0x76423e, 0xd2ceb3]);
    },
  );
});
