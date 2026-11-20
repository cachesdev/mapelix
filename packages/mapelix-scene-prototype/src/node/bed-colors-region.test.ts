import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bedEntityRecord,
  sectionRecord,
  writeFixtureWorld,
  type FixtureRecord,
} from "../../test/dimension-fixture.js";
import { resolveBlockAppearance } from "../blocks/block-appearance.js";
import { Face, decodeSceneRegion, unpackQuad } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

describe("bed color metadata through region generation", () => {
  let directory: string;
  const builders: RegionBuilder[] = [];
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-bed-colors-"));
    const records: FixtureRecord[] = [];
    for (const dimension of [0, 1, 2]) {
      records.push(
        sectionRecord(dimension, 0, 0, 4, (x, y, z) =>
          y === 79 && z === 2 && (x === 2 || x === 4) ? "minecraft:bed" : "minecraft:stone",
        ),
      );
      records.push(
        bedEntityRecord(dimension, 0, 0, [
          { x: 2, y: 79, z: 2, color: [14, 11, 4][dimension]! },
          { x: 4, y: 79, z: 2, color: 0 },
          // A stale entity at a stone position must not repaint the terrain.
          { x: 6, y: 79, z: 2, color: 13 },
        ]),
      );
    }
    await writeFixtureWorld(directory, records);
    for (const dimension of ["overworld", "nether", "the-end"] as const) {
      builders.push(new RegionBuilder({ directory, dimension }));
    }
  });
  afterAll(async () => {
    for (const builder of builders) builder.close();
    await rm(directory, { recursive: true, force: true });
  });
  it.each([0, 1, 2].flatMap((dimension) => [0, 1].map((level) => [dimension, level])))(
    "uses individual bed colors in dimension %i at LOD %i",
    (dimension, level) => {
      const region = decodeSceneRegion(builders[dimension!]!.build({ level: level!, x: 0, z: 0 }));
      const tops = new Set<number>();
      for (let index = 0; index < region.opaque.length / 3; index++) {
        const quad = unpackQuad(region.opaque, index);
        if (quad.face === Face.PositiveY) tops.add(quad.color);
      }
      expect(
        tops.has(resolveBlockAppearance("minecraft:bed", { color: [14, 11, 4][dimension!]! }).top),
      ).toBe(true);
      expect(tops.has(resolveBlockAppearance("minecraft:bed", { color: 0 }).top)).toBe(true);
      expect(tops.has(resolveBlockAppearance("minecraft:bed", { color: 13 }).top)).toBe(false);
    },
  );
});
