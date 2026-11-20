import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFixtureWorld } from "../../test/dimension-fixture.js";
import {
  EMPTY_HEIGHT,
  Face,
  QuadMaterial,
  decodeSceneRegion,
  unpackQuad,
  type DecodedSceneRegion,
} from "../format.js";
import { RegionBuilder } from "./region-builder.js";

function quads(region: DecodedSceneRegion) {
  return Array.from({ length: region.opaque.length / 3 }, (_, index) =>
    unpackQuad(region.opaque, index),
  );
}

describe("dimension region generation from LevelDB logs", () => {
  let directory: string;
  let nether: RegionBuilder;
  let end: RegionBuilder;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-dimensions-"));
    await writeFixtureWorld(directory);
    nether = new RegionBuilder({ directory, dimension: "nether" });
    end = new RegionBuilder({ directory, dimension: "the-end" });
  });
  afterAll(async () => {
    nether?.close();
    end?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([0, 1, 2, 3, 4, 5])(
    "keeps sealed Nether interiors and emissive lava at LOD %i",
    (level) => {
      const region = decodeSceneRegion(nether.build({ level, x: 0, z: 0, ceilingY: 128 }));
      const faces = quads(region);
      const scale = region.cellSize;
      expect(
        faces.some((quad) => quad.face === Face.PositiveY && (quad.y + 1) * scale === 16),
      ).toBe(true);
      expect(faces.some((quad) => quad.face === Face.NegativeY && quad.y * scale === 96)).toBe(
        true,
      );
      expect(faces.some((quad) => quad.material === QuadMaterial.Emissive)).toBe(true);
      expect(region.maxY).toBe(128);
      expect(region.minY).toBeGreaterThanOrEqual(0);
    },
  );

  it.each([0, 1, 2, 3, 4, 5])(
    "clips Nether before reduction and keeps End void at LOD %i",
    (level) => {
      const cut = decodeSceneRegion(nether.build({ level, x: 0, z: 0 }));
      expect(cut.maxY).toBeLessThanOrEqual(96);
      expect(
        quads(cut).some(
          (quad) => quad.face === Face.PositiveY && (quad.y + 1) * cut.cellSize === 16,
        ),
      ).toBe(true);
      const islands = decodeSceneRegion(end.build({ level, x: 0, z: 0 }));
      const down = quads(islands)
        .filter((quad) => quad.face === Face.NegativeY)
        .map((quad) => quad.y * islands.cellSize);
      expect(down).toContain(48);
      expect(down).toContain(112);
      expect(islands.minY).toBe(48);
      expect(islands.maxY).toBe(128);
      expect(
        quads(islands).some(
          (quad) => quad.y * islands.cellSize >= 64 && quad.y * islands.cellSize < 112,
        ),
      ).toBe(false);
      expect(islands.heights.at(-1)).toBe(level === 0 ? 128 : EMPTY_HEIGHT);
    },
  );

  it("returns empty regions for missing chunks and rejects invalid cut heights", () => {
    const region = decodeSceneRegion(end.build({ level: 0, x: -5, z: -5 }));
    expect(region.opaque.length).toBe(0);
    expect(region.heights.every((height) => height === EMPTY_HEIGHT)).toBe(true);
    expect([region.minY, region.maxY]).toEqual([0, 0]);
    expect(() => nether.build({ level: 0, x: 0, z: 0, ceilingY: 129 })).toThrow(RangeError);
  });
});
