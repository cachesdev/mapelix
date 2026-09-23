import { describe, expect, it } from "vitest";

import { Face, unpackQuad, type Quad, type SceneRegion } from "../format.js";
import { BlockPalette } from "./block-palette.js";
import {
  VOLUME_HEIGHT,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  describeVolume,
} from "./region-volume.js";
import { meshRegionVolume } from "./voxel-mesher.js";

type Place = (x: number, y: number, z: number, block: string) => void;

/** Builds a volume from placed blocks. Coordinates are region-local; the margin is added. */
function mesh(build: (place: Place) => void): readonly Quad[] {
  const palette = new BlockPalette();
  const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
  build((x, y, z, block) => {
    cells[cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN)] = palette.idFor(block, {});
  });
  const volume = describeVolume(
    { originX: -VOLUME_MARGIN, originZ: -VOLUME_MARGIN, cells },
    palette,
    () => 1,
  );
  return quadsOf(meshRegionVolume(volume, palette, 0, 0));
}

function quadsOf(region: SceneRegion): Quad[] {
  const list = region.opaque;
  return Array.from({ length: list.length / 3 }, (_, index) => unpackQuad(list, index));
}

/** A stone floor under the whole volume, including the margin. */
function floor(place: Place, y = 60): void {
  for (let z = -VOLUME_MARGIN; z < VOLUME_SIZE - VOLUME_MARGIN; z += 1) {
    for (let x = -VOLUME_MARGIN; x < VOLUME_SIZE - VOLUME_MARGIN; x += 1) {
      place(x, y, z, "minecraft:stone");
    }
  }
}

describe("voxel mesher", () => {
  it("merges a flat floor into one top face and hides the rest", () => {
    const quads = mesh((place) => floor(place));

    expect(quads).toHaveLength(1);
    expect(quads[0]).toMatchObject({
      face: Face.PositiveY,
      x: 0,
      z: 0,
      y: 60,
      width: 64,
      height: 64,
    });
  });

  it("keeps faces a camera can see and drops sealed ones", () => {
    const quads = mesh((place) => {
      floor(place);
      // A pillar on the floor shows its four sides and its top.
      place(10, 61, 10, "minecraft:stone");
      // A sealed pocket under the floor is never visible.
      place(30, 59, 30, "minecraft:stone");
    });
    const pillar = quads.filter((quad) => quad.x === 10 && quad.z === 10 && quad.y === 61);

    expect(pillar.map((quad) => quad.face).sort((left, right) => left - right)).toEqual([
      Face.PositiveX,
      Face.NegativeX,
      Face.PositiveY,
      Face.PositiveZ,
      Face.NegativeZ,
    ]);
    expect(quads.some((quad) => quad.y < 60)).toBe(false);
  });

  it("draws the underside of an overhang that open air reaches from the side", () => {
    const quads = mesh((place) => {
      floor(place);
      for (let x = 20; x < 30; x += 1) place(x, 64, 20, "minecraft:stone");
    });

    const underside = quads.filter((quad) => quad.face === Face.NegativeY && quad.y === 64);
    expect(underside).toHaveLength(1);
    expect(underside[0]).toMatchObject({ x: 20, z: 20, width: 10, height: 1 });
  });

  it("keeps the ground under a wide, high platform", () => {
    const quads = mesh((place) => {
      floor(place);
      for (let z = -8; z < 72; z += 1) {
        for (let x = -8; x < 72; x += 1) place(x, 140, z, "minecraft:stone");
      }
    });

    const ground = quads.filter((quad) => quad.face === Face.PositiveY && quad.y === 60);
    expect(ground).toEqual([expect.objectContaining({ x: 0, z: 0, width: 64, height: 64 })]);
  });
});
