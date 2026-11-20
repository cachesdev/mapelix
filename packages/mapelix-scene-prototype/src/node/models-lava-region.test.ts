import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { Face, QuadMaterial, decodeSceneRegion, unpackQuad } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

describe("block models and lava through real Bedrock palette records", () => {
  let directory: string;
  const builders: RegionBuilder[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-models-lava-"));
    const records = [0, 1, 2].flatMap((dimension) => [
      sectionRecord(dimension, 0, 0, 4, (x, y, z) => {
        if (y < 78) return "minecraft:stone";
        if (y === 78 && z === 4 && x === 4)
          return { name: "minecraft:oak_stairs", states: { weirdo_direction: 0 } };
        if (y === 78 && z === 4 && x === 8)
          return { name: "minecraft:bed", states: { direction: 0, head_piece_bit: 1 } };
        return "minecraft:air";
      }),
      // Whole chunks preserve lava identity through even the coarsest LOD.
      ...[1, 2, 3].map((x) =>
        sectionRecord(
          dimension,
          x,
          0,
          4,
          x === 1
            ? { name: "minecraft:flowing_lava", states: { liquid_depth: 3 } }
            : x === 2
              ? "minecraft:magma"
              : "minecraft:glowstone",
        ),
      ),
    ]);
    await writeFixtureWorld(directory, records);
    for (const dimension of ["overworld", "nether", "the-end"] as const)
      builders.push(new RegionBuilder({ directory, dimension }));
  });
  afterAll(async () => {
    for (const builder of builders) builder.close();
    await rm(directory, { recursive: true, force: true });
  });
  it.each([0, 1, 2])(
    "keeps stair orientation and the bed pillow/legs in dimension %i",
    (dimension) => {
      const region = decodeSceneRegion(builders[dimension]!.build({ level: 0, x: 0, z: 0 }));
      const quads = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
        unpackQuad(region.opaque, i),
      );
      const stair = quads.filter((q) => q.x === 4 && q.z === 4 && q.y === 78);
      expect(stair.some((q) => q.face === Face.PositiveY && q.modelBounds?.[4] === 8)).toBe(true);
      expect(
        stair.some(
          (q) => q.face === Face.PositiveY && q.modelBounds?.[0] === 8 && q.modelBounds[4] === 16,
        ),
      ).toBe(true);
      const bed = quads.filter((q) => q.x === 8 && q.z === 4 && q.y === 78);
      expect(bed.some((q) => q.modelBounds?.[1] === 0 && q.modelBounds[4] === 3)).toBe(true);
      expect(bed.some((q) => q.color === 0xe8e7e2)).toBe(true);
    },
  );
  it.each([0, 1, 2].flatMap((dimension) => [0, 1, 2, 3, 4, 5].map((level) => [dimension, level])))(
    "retains lava classification apart from magma and lamps in dimension %i LOD %i",
    (dimension, level) => {
      const region = decodeSceneRegion(builders[dimension!]!.build({ level: level!, x: 0, z: 0 }));
      let lavaStarted = false;
      let lavaTops = 0;
      let otherLights = 0;
      for (let i = 0; i < region.opaque.length / 3; i++) {
        const quad = unpackQuad(region.opaque, i);
        if (quad.lava) {
          lavaStarted = true;
          expect(quad.material).toBe(QuadMaterial.Emissive);
          if (quad.face === Face.PositiveY) {
            lavaTops++;
            const surface = (quad.y + quad.box.size / 16) * region.cellSize;
            expect(Math.abs(surface - (79 + 9 / 16))).toBeLessThanOrEqual(region.cellSize / 16);
          }
        } else {
          expect(lavaStarted).toBe(false);
          if (quad.material === QuadMaterial.Emissive) otherLights++;
        }
      }
      expect(lavaTops).toBeGreaterThan(0);
      expect(otherLights).toBeGreaterThan(0);
    },
  );
});
