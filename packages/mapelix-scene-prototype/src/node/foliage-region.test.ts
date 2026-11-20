import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { Face, QuadMaterial, decodeSceneRegion, unpackQuad } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

describe("colored foliage through region generation", () => {
  let directory: string;
  let builder: RegionBuilder;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-poplar-"));
    const records = ["red", "orange", "yellow"].map((variant, x) =>
      sectionRecord(0, x, 0, 5, `minecraft:${variant}_poplar_leaves`),
    );
    await writeFixtureWorld(directory, records);
    builder = new RegionBuilder({ directory, dimension: "overworld" });
  });
  afterAll(async () => {
    builder?.close();
    await rm(directory, { recursive: true, force: true });
  });
  it.each([0, 1, 2, 3, 4, 5])("retains all three poplar colors at LOD %i", (level) => {
    const region = decodeSceneRegion(builder.build({ level, x: 0, z: 0 }));
    const topColors = new Set<number>();
    for (let index = 0; index < region.opaque.length / 3; index++) {
      const quad = unpackQuad(region.opaque, index);
      if (quad.face === Face.PositiveY && quad.material === QuadMaterial.Foliage)
        topColors.add(quad.color);
    }
    expect([...topColors].sort()).toEqual([0x9a2c27, 0xbc5618, 0xd78628].sort());
  });
});
