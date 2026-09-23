import { describe, expect, it } from "vitest";

import { VoxelKind } from "./block-palette.js";
import { VoxelBox, halveVoxels } from "./voxel-box.js";

const STONE = 0x7d7d7d;
const WATER = 0x3f76e4;

/** Fills whole layers of a box with one kind of voxel. */
function fillLayers(box: VoxelBox, from: number, to: number, kind: number, fill = 16): void {
  for (let layer = from; layer <= to; layer += 1) {
    for (let z = 0; z < box.width; z += 1) {
      for (let x = 0; x < box.width; x += 1) {
        const index = box.index(x, layer, z);
        box.kind[index] = kind;
        box.top[index] = kind === VoxelKind.Water ? WATER : STONE;
        box.side[index] = box.top[index]!;
        box.fill[index] = fill;
      }
    }
  }
}

/** Kind and fill of each layer in the first column, from the bottom up. */
function column(box: VoxelBox): string[] {
  return Array.from({ length: box.layers }, (_, layer) => {
    const index = box.index(0, layer, 0);
    return `${box.kind[index]}/${box.fill[index]}`;
  });
}

describe("halveVoxels", () => {
  it("keeps a floor one voxel thick above open air", () => {
    const box = new VoxelBox(4, 8);
    fillLayers(box, 0, 0, VoxelKind.Solid);
    fillLayers(box, 5, 5, VoxelKind.Solid);

    expect(column(halveVoxels(box))).toEqual(["1/16", "0/0", "1/16", "0/0"]);
  });

  it("keeps the sea surface at its height and lets blocks win ties with water", () => {
    const sea = new VoxelBox(2, 8);
    fillLayers(sea, 0, 3, VoxelKind.Water);
    fillLayers(sea, 4, 4, VoxelKind.Water, 14);

    expect(column(halveVoxels(sea))).toEqual(["4/16", "4/16", "4/7", "0/0"]);

    const shore = new VoxelBox(2, 2);
    fillLayers(shore, 0, 1, VoxelKind.Water);
    shore.kind[shore.index(0, 1, 0)] = VoxelKind.Solid;
    shore.kind[shore.index(1, 1, 1)] = VoxelKind.Solid;

    expect(halveVoxels(shore).kind[0]).toBe(VoxelKind.Solid);
  });
});
