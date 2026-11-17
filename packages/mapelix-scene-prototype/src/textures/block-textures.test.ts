import { describe, expect, it } from "vitest";

import { resolveBlockAppearance } from "../blocks/block-appearance.js";
import { Face } from "../format.js";
import { resolveBlockTextures, type TextureNames } from "./block-textures.js";
import type { BlockTextureNames, TerrainEntry } from "./resource-pack.js";

const all = (name: string): BlockTextureNames => ({
  up: name,
  down: name,
  north: name,
  south: name,
  east: name,
  west: name,
});
const blocks: Record<string, BlockTextureNames> = {
  grass: { ...all("grass_side"), up: "grass_top", down: "dirt" },
  oak_log: { ...all("log_side"), up: "log_top", down: "log_top" },
  furnace: {
    ...all("furnace_side"),
    up: "furnace_top",
    down: "furnace_top",
    south: "furnace_front",
  },
  wheat: all("wheat"),
  chain: all("chain"),
  oak_leaves: all("leaves"),
  poppy: all("poppy"),
};
const terrain: Record<string, TerrainEntry> = Object.fromEntries(
  [
    "grass_side",
    "grass_top",
    "dirt",
    "log_side",
    "log_top",
    "furnace_side",
    "furnace_top",
    "furnace_front",
    "chain",
    "poppy",
  ].map((name) => [name, { textures: [{ path: `textures/blocks/${name}` }] }]),
);
terrain["wheat"] = {
  textures: Array.from({ length: 8 }, (_, stage) => ({ path: `textures/blocks/wheat_${stage}` })),
};
terrain["leaves"] = {
  textures: [{ path: "textures/blocks/leaves" }, { path: "textures/blocks/leaves_opaque" }],
};
const names: TextureNames = {
  blockTextures: (block) => blocks[block],
  terrainEntry: (name) => terrain[name],
};

function resolve(name: string, states: Record<string, string | number> = {}) {
  return resolveBlockTextures(names, name, states, resolveBlockAppearance(name, states));
}

describe("block textures", () => {
  it("gives a grass block its top, side and bottom, tinting only the top", () => {
    const faces = resolve("minecraft:grass_block")!.faces;
    expect(faces[Face.PositiveY]).toEqual({
      path: "textures/blocks/grass_top",
      rotation: 0,
      tinted: true,
    });
    expect(faces[Face.NegativeY]?.path).toBe("textures/blocks/dirt");
    for (const face of [Face.PositiveX, Face.NegativeX, Face.PositiveZ, Face.NegativeZ]) {
      expect(faces[face]).toEqual({
        path: "textures/blocks/grass_side",
        rotation: 0,
        tinted: false,
      });
    }
  });

  it("puts a log's rings on the faces along its axis and turns its bark along it", () => {
    const upright = resolve("minecraft:oak_log", { pillar_axis: "y" })!.faces;
    expect(upright[Face.PositiveY]?.path).toBe("textures/blocks/log_top");
    expect(upright[Face.PositiveX]).toEqual({
      path: "textures/blocks/log_side",
      rotation: 0,
      tinted: false,
    });

    const alongX = resolve("minecraft:oak_log", { pillar_axis: "x" })!.faces;
    expect(alongX[Face.PositiveX]?.path).toBe("textures/blocks/log_top");
    expect(alongX[Face.NegativeX]?.path).toBe("textures/blocks/log_top");
    // Top faces run u along x, the side faces facing z too: both turn.
    expect(alongX[Face.PositiveY]).toMatchObject({ path: "textures/blocks/log_side", rotation: 1 });
    expect(alongX[Face.PositiveZ]).toMatchObject({ path: "textures/blocks/log_side", rotation: 1 });

    const alongZ = resolve("minecraft:oak_log", { pillar_axis: "z" })!.faces;
    expect(alongZ[Face.NegativeZ]?.path).toBe("textures/blocks/log_top");
    expect(alongZ[Face.PositiveY]).toMatchObject({ path: "textures/blocks/log_side", rotation: 0 });
    expect(alongZ[Face.PositiveX]).toMatchObject({ path: "textures/blocks/log_side", rotation: 1 });
  });

  it("turns a furnace's front toward the direction it faces", () => {
    const front = (states: Record<string, string | number>) =>
      resolve("minecraft:furnace", states)!
        .faces.map((texture, face) => (texture?.path.endsWith("front") ? face : -1))
        .filter((face) => face >= 0);
    expect(front({})).toEqual([Face.PositiveZ]);
    expect(front({ "minecraft:cardinal_direction": "south" })).toEqual([Face.PositiveZ]);
    expect(front({ "minecraft:cardinal_direction": "north" })).toEqual([Face.NegativeZ]);
    expect(front({ "minecraft:cardinal_direction": "east" })).toEqual([Face.PositiveX]);
    expect(front({ "minecraft:cardinal_direction": "west" })).toEqual([Face.NegativeX]);
    expect(front({ facing_direction: 4 })).toEqual([Face.NegativeX]);
  });

  it("picks growth stages, first variants, aliases and crossed plant textures", () => {
    expect(resolve("minecraft:wheat", { growth: 0 })!.cross?.path).toBe("textures/blocks/wheat_0");
    expect(resolve("minecraft:wheat", { growth: 7 })!.cross?.path).toBe("textures/blocks/wheat_7");
    expect(resolve("minecraft:oak_leaves")!.faces[Face.PositiveX]).toEqual({
      path: "textures/blocks/leaves",
      rotation: 0,
      tinted: true,
    });
    expect(resolve("minecraft:iron_chain")!.faces[Face.PositiveY]?.path).toBe(
      "textures/blocks/chain",
    );
    expect(resolve("minecraft:poppy")!.cross).toEqual({
      path: "textures/blocks/poppy",
      rotation: 0,
      tinted: false,
    });
    expect(resolve("minecraft:unknown_block")).toBeUndefined();
  });
});
