import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { Face, decodeSceneRegion, unpackQuad, type DecodedSceneRegion } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

let directory: string;
const builders: RegionBuilder[] = [];
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mapelix-block-light-"));
  await writeFixtureWorld(
    directory,
    [0, 1, 2].flatMap((dimension) =>
      [-2, -1, 0, 1, 2, 3, 4, 5].flatMap((chunkX) => [
        sectionRecord(dimension, chunkX, 0, 3, (_x, y) =>
          y === 63 ? "minecraft:stone" : "minecraft:air",
        ),
        sectionRecord(dimension, chunkX, 0, 4, (x, y, z) =>
          y === 64 && z === 8 && (x === -1 || x === 63) ? "minecraft:lantern" : "minecraft:air",
        ),
        ...(dimension !== 0
          ? []
          : [
              sectionRecord(dimension, chunkX, 0, -1, (_x, y) =>
                y === -1 ? "minecraft:stone" : "minecraft:air",
              ),
              sectionRecord(dimension, chunkX, 0, 0, (x, y, z) =>
                x === 8 && y === 0 && z === 8 ? "minecraft:lantern" : "minecraft:air",
              ),
            ]),
      ]),
    ),
  );
  for (const dimension of ["overworld", "nether", "the-end"] as const)
    builders.push(new RegionBuilder({ directory, dimension }));
});
afterAll(async () => {
  for (const builder of builders) builder.close();
  await rm(directory, { recursive: true, force: true });
});

function topLight(region: DecodedSceneRegion, worldX: number, y: number, z: number): number {
  const x = worldX - region.originX;
  for (let i = 0; i < region.opaque.length / 3; i++) {
    const q = unpackQuad(region.opaque, i);
    if (
      q.face === Face.PositiveY &&
      q.y === y &&
      q.x <= x &&
      x < q.x + q.width &&
      q.z <= z &&
      z < q.z + q.height
    )
      return region.blockLight?.opaque[i] ?? 0;
  }
  throw new Error(`Missing floor at ${worldX},${y},${z}`);
}

it.each([0, 1, 2])(
  "lights both sides of positive and negative region boundaries in dimension %i",
  (dimension) => {
    const builder = builders[dimension]!;
    for (const textured of [false, true]) {
      const textures = textured
        ? { textures: { fingerprint: "empty", blocks: {}, tiles: {}, terrain: {} } }
        : {};
      const left = decodeSceneRegion(builder.build({ level: 0, x: -1, z: 0, ...textures }));
      const middle = decodeSceneRegion(builder.build({ level: 0, x: 0, z: 0, ...textures }));
      const right = decodeSceneRegion(builder.build({ level: 0, x: 1, z: 0, ...textures }));
      expect(topLight(left, -1, 63, 8)).toBe(15);
      expect(topLight(middle, 0, 63, 8)).toBe(14);
      expect(topLight(middle, 63, 63, 8)).toBe(15);
      expect(topLight(right, 64, 63, 8)).toBe(14);
      if (textured) expect(middle.textures!.opaque.every((word) => word === 0)).toBe(true);
    }
  },
);

it("lights LOD 1 as well as detailed geometry, and omits the distant light plane", () => {
  const near = decodeSceneRegion(builders[0]!.build({ level: 1, x: 0, z: 0 }));
  expect(topLight(near, 64, 63, 8)).toBe(14);
  expect(topLight(near, 0, 63, 8)).toBe(14);
  const far = decodeSceneRegion(builders[0]!.build({ level: 2, x: 0, z: 0 }));
  expect(far.blockLight).toBeUndefined();
});

it("keeps sources just outside a cave slice in its vertical light margin", () => {
  for (const level of [0, 1]) {
    const region = decodeSceneRegion(
      builders[0]!.build({ mode: "caves", minY: -32, maxY: 0, level, x: 0, z: 0 }),
    );
    // LOD 1 represents the lantern itself as an opaque voxel, hiding the floor below it.
    if (level === 0) expect(topLight(region, 8, -1, 8)).toBe(15);
    expect(topLight(region, 9, -1, 8)).toBe(14);
  }
});
