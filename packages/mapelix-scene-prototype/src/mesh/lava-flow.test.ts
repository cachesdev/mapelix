import { describe, expect, it } from "vitest";
import { lavaFlowDirection } from "./lava-flow.js";
import { VoxelKind } from "./block-palette.js";
import { VoxelBox, halveVoxels } from "./voxel-box.js";

describe("lava flow and reduction", () => {
  it("flows toward lower neighbors in every compass octant, and convects when level", () => {
    expect(lavaFlowDirection(14, 14, 14, 14)).toBe(0);
    expect(lavaFlowDirection(2, 14, 14, 14)).toBe(1);
    expect(lavaFlowDirection(2, 14, 2, 14)).toBe(2);
    expect(lavaFlowDirection(14, 14, 2, 14)).toBe(3);
    expect(lavaFlowDirection(14, 2, 2, 14)).toBe(4);
    expect(lavaFlowDirection(14, 2, 14, 14)).toBe(5);
    expect(lavaFlowDirection(14, 2, 14, 2)).toBe(6);
    expect(lavaFlowDirection(14, 14, 14, 2)).toBe(7);
    expect(lavaFlowDirection(2, 14, 14, 2)).toBe(8);
  });
  it("does not turn magma/lamps into lava, and retains a lava donor when it wins a mixed group", () => {
    for (const kind of [VoxelKind.Solid, VoxelKind.Emissive, VoxelKind.Lava]) {
      const source = new VoxelBox(2, 2);
      source.kind.fill(kind);
      source.top.fill(0xd55b13);
      source.side.fill(0xd55b13);
      source.fill.fill(14);
      expect(halveVoxels(source).kind[0]).toBe(kind);
      if (kind === VoxelKind.Lava) {
        source.kind[0] = VoxelKind.Emissive;
        expect(halveVoxels(source).kind[0]).toBe(VoxelKind.Lava);
      }
    }
  });
});
