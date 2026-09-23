import { describe, expect, it } from "vitest";

import { Face, regionCellSize, regionGridSize, unpackQuad, type Quad } from "../format.js";
import { VoxelKind } from "./block-palette.js";
import { VoxelBox } from "./voxel-box.js";
import { meshVoxelRegion } from "./voxel-level-mesher.js";

const LEVEL = 3;
const SPAN = regionGridSize(LEVEL);
const MARGIN = 4;

/** Meshes a level 3 region of stone voxels. Coordinates are region-local; the margin is added. */
function mesh(build: (place: (x: number, layer: number, z: number) => void) => void): Quad[] {
  const box = new VoxelBox(SPAN + MARGIN * 2, 24);
  build((x, layer, z) => {
    const index = box.index(x + MARGIN, layer, z + MARGIN);
    box.kind[index] = VoxelKind.Solid;
    box.top[index] = 0x7d7d7d;
    box.side[index] = 0x7d7d7d;
    box.fill[index] = 16;
  });
  const region = meshVoxelRegion({
    level: LEVEL,
    x: 0,
    z: 0,
    voxelSize: regionCellSize(LEVEL),
    span: SPAN,
    margin: MARGIN,
    low: 0,
    box,
    explored: new Uint8Array(box.width ** 2).fill(1),
  });
  return Array.from({ length: region.opaque.length / 3 }, (_, index) =>
    unpackQuad(region.opaque, index),
  );
}

describe("voxel level mesher", () => {
  it("draws a floating platform as a slab over open ground", () => {
    const quads = mesh((place) => {
      for (let z = -MARGIN; z < SPAN + MARGIN; z += 1) {
        for (let x = -MARGIN; x < SPAN + MARGIN; x += 1) place(x, 15, z);
      }
      for (let z = 40; z < 50; z += 1) {
        for (let x = 40; x < 50; x += 1) place(x, 20, z);
      }
    });

    const underside = quads.filter((quad) => quad.face === Face.NegativeY);
    expect(underside).toEqual([expect.objectContaining({ x: 40, z: 40, y: 20, width: 10 })]);
    expect(quads.some((quad) => quad.y > 15 && quad.y < 20)).toBe(false);
  });
});
