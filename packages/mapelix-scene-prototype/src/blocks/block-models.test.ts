import { describe, expect, it } from "vitest";
import { BlockPalette, Shape, VoxelKind } from "../mesh/block-palette.js";
import { packModelBounds, unpackModelBounds } from "../format.js";
import {
  blockModelParts,
  modelCatalog,
  resolveBlockModel,
  type BlockModel,
  type ModelNeighbors,
} from "./block-models.js";

function model(block: string, states = {}): BlockModel {
  return resolveBlockModel(block, states)!;
}
function parts(block: string, states = {}, neighbors?: ModelNeighbors) {
  return blockModelParts(model(block, states), neighbors);
}
const volume = (block: BlockModel) =>
  blockModelParts(block).reduce(
    (v, { bounds: b }) => v + (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]),
    0,
  );

describe("Bedrock block models", () => {
  it("gives every catalog cuboid valid sixteenth coordinates", () => {
    for (const entry of modelCatalog())
      for (const { bounds } of blockModelParts(entry)) {
        for (let axis = 0; axis < 3; axis++) {
          expect(bounds[axis]).toBeGreaterThanOrEqual(0);
          expect(bounds[axis + 3]).toBeLessThanOrEqual(16);
          expect(bounds[axis + 3]).toBeGreaterThan(bounds[axis]!);
        }
        expect(unpackModelBounds(packModelBounds(bounds))).toEqual(bounds);
      }
  });
  it.each([0, 1, 2, 3])(
    "keeps straight, inner and outer stair volume in orientation %i",
    (weirdo_direction) => {
      for (const upside_down_bit of [0, 1]) {
        const stair = (corner: string) =>
          model("oak_stairs", { weirdo_direction, upside_down_bit, "minecraft:corner": corner });
        expect(volume(stair("none"))).toBe(3072);
        for (const side of ["left", "right"]) {
          expect(volume(stair(`outer_${side}`))).toBe(2560);
          expect(volume(stair(`inner_${side}`))).toBe(3584);
        }
      }
    },
  );
  it("preserves direction and corner states in the palette, without splitting on redstone power", () => {
    const palette = new BlockPalette();
    const a = palette.idFor("minecraft:oak_stairs", { weirdo_direction: 0 });
    expect(palette.shape[a]).toBe(Shape.Model);
    expect(palette.idFor("minecraft:oak_stairs", { weirdo_direction: 1 })).not.toBe(a);
    expect(palette.idFor("minecraft:oak_stairs", { weirdo_direction: 0, powered_bit: 1 })).toBe(a);
    expect(palette.idFor("minecraft:oak_stairs", { upside_down_bit: 1, weirdo_direction: 2 })).toBe(
      palette.idFor("minecraft:oak_stairs", { weirdo_direction: 2, upside_down_bit: 1 }),
    );
  });
  it("uses the lower door's facing/open state and the upper door's hinge in both halves", () => {
    const lower = model("wooden_door", { direction: 0, open_bit: 1 });
    const upper = model("wooden_door", { upper_block_bit: 1, door_hinge_bit: 1 });
    const lowerParts = blockModelParts(lower, (_x, y) => ({
      opaque: false,
      model: y === 1 ? upper : undefined,
    }));
    const upperParts = blockModelParts(upper, (_x, y) => ({
      opaque: false,
      model: y === -1 ? lower : undefined,
    }));
    expect(lowerParts).toEqual(upperParts);
    expect(lowerParts[0]!.bounds).toEqual([13, 0, 0, 16, 16, 16]);
    expect(
      parts("wooden_door", { direction: 0, open_bit: 1, door_hinge_bit: 0 })[0]!.bounds,
    ).toEqual([0, 0, 0, 3, 16, 16]);
  });
  it("honors explicit connections and reconstructs absent fence connections from neighbors", () => {
    expect(parts("oak_fence")).toHaveLength(1);
    expect(parts("oak_fence", { "minecraft:connection_east": 1 })).toHaveLength(3);
    const solid: ModelNeighbors = (x) => ({ opaque: x === 1 });
    expect(parts("oak_fence", {}, solid)).toHaveLength(3);
    expect(parts("oak_fence", { "minecraft:connection_east": 0 }, solid)).toHaveLength(1);
    expect(
      parts("nether_brick_fence", {}, () => ({ opaque: false, model: model("oak_fence") })),
    ).toHaveLength(1);
    expect(
      parts("oak_fence", {}, (x) => ({
        opaque: false,
        model: x === 1 ? model("oak_fence_gate", { direction: 1 }) : undefined,
      })),
    ).toHaveLength(1);
    expect(parts("glass_pane", {}, (x) => ({ opaque: false, glass: x === 1 }))).toHaveLength(2);
  });
  it("keeps open gates, vertical trapdoors, hollow scaffolding and bed legs", () => {
    expect(parts("oak_fence_gate", { open_bit: 1 })).not.toEqual(parts("oak_fence_gate"));
    expect(parts("trapdoor", { open_bit: 1 })[0]!.bounds).toEqual([0, 0, 13, 16, 16, 16]);
    const scaffold = parts("scaffolding");
    expect(
      scaffold.some(
        ({ bounds: b }) => b[0] <= 8 && b[3] >= 8 && b[2] <= 8 && b[5] >= 8 && b[1] < 14,
      ),
    ).toBe(false);
    const bed = parts("bed", { head_piece_bit: 1 });
    expect(bed.filter(({ bounds: b }) => b[1] === 0)).toHaveLength(2);
    expect(bed.some((p) => p.color === 0xe8e7e2)).toBe(true);
  });
  it("connects chorus on all six axes and retains its geometry at nearby LOD", () => {
    const s = Object.fromEntries(
      ["north", "south", "east", "west", "up", "down"].map((side) => [
        `minecraft:connection_${side}`,
        1,
      ]),
    );
    expect(parts("chorus_plant", s)).toHaveLength(7);
    const palette = new BlockPalette();
    expect(palette.voxel[palette.idFor("minecraft:chorus_plant", s)]).toBe(VoxelKind.Solid);
    expect(resolveBlockModel("unknown", {})).toBeUndefined();
  });
  it("uses the ZIP's low straw mattress instead of the wooden bed frame", () => {
    expect(parts("straw_bed")[0]!.bounds).toEqual([0, 0, 0, 16, 4, 16]);
    const head = parts("straw_bed", { head_piece_bit: 1 });
    expect(head.map((p) => p.bounds[4])).toEqual([4, 5]);
    expect(head.every((p) => p.color === undefined)).toBe(true);
  });

  it("gives standing and hanging end rods their base, and lying ones their rod alone", () => {
    const bounds = (facing_direction: number) =>
      parts("end_rod", { facing_direction }).map((p) => p.bounds);
    expect(bounds(1)).toEqual([
      [7, 0, 7, 9, 16, 9],
      [6, 0, 6, 10, 1, 10],
    ]);
    expect(bounds(0)).toEqual([
      [7, 0, 7, 9, 16, 9],
      [6, 15, 6, 10, 16, 10],
    ]);
    expect(bounds(5)).toEqual([[0, 7, 7, 16, 9, 9]]);
    expect(bounds(2)).toEqual([[7, 7, 0, 9, 9, 16]]);
  });

  it.each(["lightning_rod", "exposed_lightning_rod", "waxed_oxidized_lightning_rod"])(
    "draws %s as a rod with its tip on top of standing and hanging rods",
    (block) => {
      const bounds = (facing_direction: number) =>
        parts(block, { facing_direction }).map((p) => p.bounds);
      expect(bounds(1)).toEqual([
        [7, 0, 7, 9, 16, 9],
        [6, 12, 6, 10, 16, 10],
      ]);
      expect(bounds(0)).toEqual([
        [7, 0, 7, 9, 16, 9],
        [6, 0, 6, 10, 4, 10],
      ]);
      expect(bounds(4)).toEqual([[0, 7, 7, 16, 9, 9]]);
    },
  );
});
