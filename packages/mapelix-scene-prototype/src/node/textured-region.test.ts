import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sectionRecord, writeFixtureWorld } from "../../test/dimension-fixture.js";
import {
  Face,
  REGION_FLAG_TEXTURED,
  decodeSceneRegion,
  isLavaQuad,
  unpackQuad,
  type Quad,
} from "../format.js";
import type { PaletteTextures } from "../mesh/block-palette.js";
import { unpackQuadTexture } from "../textures/atlas-format.js";
import type { BlockTextureNames } from "../textures/resource-pack.js";
import { RegionBuilder } from "./region-builder.js";

const all = (name: string): BlockTextureNames => ({
  up: name,
  down: name,
  north: name,
  south: name,
  east: name,
  west: name,
});
const TEXTURES = [
  "stone",
  "grass_top",
  "grass_side",
  "dirt",
  "poppy",
  "still_water",
  "still_lava",
  "log_side",
  "log_top",
  "leaves_oak",
  "leaf_litter",
];
const index: PaletteTextures = {
  fingerprint: "0123456789abcdef0123",
  tiles: Object.fromEntries(TEXTURES.map((name, tile) => [`textures/blocks/${name}`, tile])),
  blocks: {
    stone: all("stone"),
    grass: { ...all("grass_side"), up: "grass_top", down: "dirt" },
    poppy: all("poppy"),
    water: all("still_water"),
    flowing_water: all("still_water"),
    lava: all("still_lava"),
    oak_log: { ...all("log_side"), up: "log_top", down: "log_top" },
    oak_leaves: all("leaves_oak"),
    leaf_litter: all("leaf_litter"),
  },
  terrain: Object.fromEntries(
    TEXTURES.map((name) => [name, { textures: [{ path: `textures/blocks/${name}` }] }]),
  ),
};
const tile = (name: string): number => TEXTURES.indexOf(name);

describe("textured regions", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-textured-"));
    await writeFixtureWorld(directory, [
      sectionRecord(0, 0, 0, 4, (x, y, z) => {
        if (y < 70) return "minecraft:stone";
        if (y === 70)
          return x === 13 && z === 14 ? "minecraft:grass_path" : "minecraft:grass_block";
        if (y !== 71) return "minecraft:air";
        if (x === 2 && z === 2) return "minecraft:poppy";
        if (z === 8 && (x === 8 || x === 9)) return "minecraft:water";
        if (x === 12 && z === 12) return { name: "minecraft:lava", states: { liquid_depth: 0 } };
        if (x === 5 && z === 5) return { name: "minecraft:oak_log", states: { pillar_axis: "x" } };
        if (x === 6 && z === 6) return "minecraft:oak_stairs";
        if (x === 14 && z === 14) return "minecraft:leaf_litter";
        if (x === 13 && z === 14) return "minecraft:leaf_litter";
        return "minecraft:air";
      }),
      // A 3 by 3 by 3 bush of leaves in the next section up.
      sectionRecord(0, 0, 0, 5, (x, y, z) => {
        if (x >= 10 && x <= 12 && z >= 2 && z <= 4 && y >= 81 && y <= 83)
          return "minecraft:oak_leaves";
        return "minecraft:air";
      }),
    ]);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("leaves plain regions byte for byte as they were", () => {
    const fresh = new RegionBuilder({ directory, dimension: "overworld" });
    const plain = fresh.build({ level: 0, x: 0, z: 0 });
    fresh.close();
    const mixed = new RegionBuilder({ directory, dimension: "overworld" });
    mixed.build({ level: 0, x: 0, z: 0, textures: index });
    expect(mixed.build({ level: 0, x: 0, z: 0 })).toEqual(plain);
    expect(mixed.build({ level: 1, x: 0, z: 0 }).byteLength).toBeGreaterThan(0);
    mixed.close();
    expect(decodeSceneRegion(plain).textures).toBeUndefined();
    expect(plain[7]! & REGION_FLAG_TEXTURED).toBe(0);
  });

  it("gives each quad its face texture, tinted as its color is", () => {
    const builder = new RegionBuilder({ directory, dimension: "overworld" });
    const plain = decodeSceneRegion(builder.build({ level: 0, x: 0, z: 0 }));
    const region = decodeSceneRegion(builder.build({ level: 0, x: 0, z: 0, textures: index }));
    const textures = region.textures!;
    expect(textures.opaque.length * 3).toBe(region.opaque.length);
    expect(textures.plants.length * 3).toBe(region.plants.length);
    expect(textures.translucent.length * 3).toBe(region.translucent.length);
    const quads = (words: Uint32Array, words4: Uint32Array) =>
      Array.from({ length: words4.length }, (_, i) => ({
        quad: unpackQuad(words, i),
        word0: words[i * 3]!,
        word1: words[i * 3 + 1]!,
        texture: unpackQuadTexture(words4[i]!),
      }));
    const opaque = quads(region.opaque, textures.opaque);
    const at = (x: number, y: number, z: number, face: Face) =>
      opaque.find(
        ({ quad }: { quad: Quad }) =>
          quad.face === face &&
          quad.y === y &&
          x >= quad.x &&
          z >= quad.z &&
          x < quad.x + (face === Face.PositiveY || face === Face.NegativeY ? quad.width : 1) &&
          z < quad.z + (face === Face.PositiveY || face === Face.NegativeY ? quad.height : 1),
      );

    // Grass tops take the biome color; their sides keep the texture's own colors.
    expect(at(0, 70, 0, Face.PositiveY)?.texture).toEqual({
      tile: tile("grass_top"),
      rotation: 0,
      tinted: true,
    });
    const side = opaque.find(({ quad }) => quad.face === Face.PositiveX && quad.y === 70);
    expect(side?.texture).toEqual({ tile: tile("grass_side"), rotation: 0, tinted: false });
    // A log lying along x turns its bark on the top face, and shows its rings at the ends.
    expect(at(5, 71, 5, Face.PositiveY)?.texture).toEqual({
      tile: tile("log_side"),
      rotation: 1,
      tinted: false,
    });
    expect(
      opaque.find(({ quad }) => quad.face === Face.PositiveX && quad.y === 71 && quad.x === 5)
        ?.texture?.tile,
    ).toBe(tile("log_top"));
    // A block the atlas lacks keeps its color.
    expect(
      opaque.some(({ quad, texture }) => quad.modelBounds !== undefined && texture === undefined),
    ).toBe(true);
    // Lava stays grouped at the end of the opaque quads with its texture.
    const lava = opaque.filter(({ word0, word1 }) => isLavaQuad(word0, word1));
    expect(lava.length).toBeGreaterThan(0);
    expect(opaque.slice(-lava.length).every(({ word0, word1 }) => isLavaQuad(word0, word1))).toBe(
      true,
    );
    expect(lava.every(({ texture }) => texture?.tile === tile("still_lava"))).toBe(true);

    const plants = quads(region.plants, textures.plants);
    expect(plants.map(({ texture }) => texture)).toEqual([
      { tile: tile("poppy"), rotation: 0, tinted: false },
      { tile: tile("poppy"), rotation: 0, tinted: false },
    ]);
    const water = quads(region.translucent, textures.translucent);
    expect(water.length).toBeGreaterThan(0);
    expect(
      water.every(({ texture }) => texture?.tile === tile("still_water") && texture.tinted),
    ).toBe(true);

    // The same faces, colors and occlusion as the plain region: only merging can differ.
    const area = (words: Uint32Array) => {
      let sum = 0;
      for (let i = 0; i < words.length / 3; i++) {
        const quad = unpackQuad(words, i);
        sum += quad.width * quad.height;
      }
      return sum;
    };
    expect(area(region.opaque)).toBe(area(plain.opaque));
    expect(region.plants).toEqual(plain.plants);
    builder.close();
  });

  it("draws the faces between cut-out leaves only when asked", () => {
    const builder = new RegionBuilder({ directory, dimension: "overworld" });
    // Another index, so another fingerprint: a builder keeps the index it was given under it.
    const cutoutIndex = {
      ...index,
      fingerprint: "fedcba9876543210fedc",
      cutout: [tile("leaves_oak"), tile("leaf_litter")],
    };
    const textureOf = (bytes: Uint8Array, name: string) => {
      const region = decodeSceneRegion(bytes);
      let area = 0;
      const cutout = new Set<boolean>();
      for (let i = 0; i < region.textures!.opaque.length; i++) {
        const texture = unpackQuadTexture(region.textures!.opaque[i]!);
        if (texture?.tile !== tile(name)) continue;
        const quad = unpackQuad(region.opaque, i);
        area += quad.width * quad.height;
        cutout.add(texture.cutout === true);
      }
      return { area, cutout: [...cutout] };
    };
    const leafArea = (bytes: Uint8Array) => textureOf(bytes, "leaves_oak").area;
    const fast = builder.build({ level: 0, x: 0, z: 0, textures: cutoutIndex });
    const detailed = builder.build({ level: 0, x: 0, z: 0, textures: cutoutIndex, cutout: true });
    // The bush's outside, 6 sides of 9 faces, then every face of its 27 leaves.
    expect(leafArea(fast)).toBe(54);
    expect(leafArea(detailed)).toBe(27 * 6);
    // Fast leaves fill their holes; detailed ones and leaf litter always cut them out.
    expect(textureOf(fast, "leaves_oak").cutout).toEqual([false]);
    expect(textureOf(detailed, "leaves_oak").cutout).toEqual([true]);
    expect(textureOf(fast, "leaf_litter").cutout).toEqual([true]);
    expect(textureOf(detailed, "leaf_litter").cutout).toEqual([true]);
    // Leaf litter's gray texture takes its brown color.
    const litter = decodeSceneRegion(fast);
    expect(
      Array.from(litter.textures!.opaque, (word) => unpackQuadTexture(word))
        .filter((texture) => texture?.tile === tile("leaf_litter"))
        .every((texture) => texture!.tinted),
    ).toBe(true);
    // The grass under the litter shows through its holes, so it is drawn.
    const grassUnder = (bytes: Uint8Array) => {
      const region = decodeSceneRegion(bytes);
      return Array.from({ length: region.opaque.length / 3 }, (_, i) =>
        unpackQuad(region.opaque, i),
      ).some(
        (quad) =>
          quad.face === Face.PositiveY &&
          quad.y === 70 &&
          quad.x <= 14 &&
          quad.z <= 14 &&
          quad.x + quad.width > 14 &&
          quad.z + quad.height > 14,
      );
    };
    expect(grassUnder(fast)).toBe(true);
    expect(grassUnder(builder.build({ level: 0, x: 0, z: 0 }))).toBe(false);
    // So does the lower top of a path, inside its own cell.
    const pathUnder = (bytes: Uint8Array) => {
      const region = decodeSceneRegion(bytes);
      return Array.from({ length: region.opaque.length / 3 }, (_, i) =>
        unpackQuad(region.opaque, i),
      ).some(
        (quad) =>
          quad.face === Face.PositiveY &&
          quad.y === 70 &&
          quad.x <= 13 &&
          quad.z <= 14 &&
          quad.x + quad.width > 13 &&
          quad.z + quad.height > 14 &&
          quad.box.size === 15,
      );
    };
    expect(pathUnder(fast)).toBe(true);
    // Without a cut-out tile the option changes nothing.
    expect(builder.build({ level: 0, x: 0, z: 0, textures: index, cutout: true })).toEqual(
      builder.build({ level: 0, x: 0, z: 0, textures: index }),
    );
    expect(() => builder.build({ level: 0, x: 0, z: 0, cutout: true })).toThrow(/need textures/);
    builder.close();
  });

  it("names a texture index it holds by fingerprint, and textures level 0 only", () => {
    const builder = new RegionBuilder({ directory, dimension: "overworld" });
    expect(() => builder.build({ level: 0, x: 0, z: 0, textures: index.fingerprint })).toThrow(
      /was not received/,
    );
    const full = builder.build({ level: 0, x: 0, z: 0, textures: index });
    expect(builder.build({ level: 0, x: 0, z: 0, textures: index.fingerprint })).toEqual(full);
    expect(() => builder.build({ level: 1, x: 0, z: 0, textures: index })).toThrow(/level 0/);
    builder.close();
  });
});
