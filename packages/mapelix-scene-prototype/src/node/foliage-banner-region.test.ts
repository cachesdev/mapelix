import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  bedEntityRecord,
  biomeRecord,
  sectionRecord,
  writeFixtureWorld,
} from "../../test/dimension-fixture.js";
import { Face, decodeSceneRegion, unpackQuad } from "../format.js";
import { unpackQuadTexture, QUAD_CUTOUT } from "../textures/atlas-format.js";
import { BANNER_TILE } from "../textures/banner-tile.js";
import { resolveBlockAppearance } from "../blocks/block-appearance.js";
import { RegionBuilder } from "./region-builder.js";

let directory: string;
let builder: RegionBuilder;
const DYES = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "light_gray",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
];
const textures = {
  fingerprint: "foliage-banner",
  tiles: { [BANNER_TILE]: 0, lily: 1, vine: 2, wood: 3 },
  blocks: {
    waterlily: {
      up: "lily",
      down: "lily",
      north: "lily",
      south: "lily",
      east: "lily",
      west: "lily",
    },
    vine: { up: "vine", down: "vine", north: "vine", south: "vine", east: "vine", west: "vine" },
    wall_banner: {
      up: "wood",
      down: "wood",
      north: "wood",
      south: "wood",
      east: "wood",
      west: "wood",
    },
  },
  terrain: {
    lily: { textures: [{ path: "lily" }] },
    vine: { textures: [{ path: "vine" }] },
    wood: { textures: [{ path: "wood" }] },
  },
  cutout: [1, 2],
};

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mapelix-foliage-banner-"));
  await writeFixtureWorld(
    directory,
    [0, 1, 2, 3].flatMap((cx) => [
      sectionRecord(0, cx, 0, 3, (_x, y) => (y === 63 ? "minecraft:stone" : "minecraft:air")),
      sectionRecord(0, cx, 0, 4, (x, y, z) => {
        if (y !== 64) return "minecraft:air";
        if (z === 5 && x >= 2 && x < 50 && (x - 2) % 3 === 0)
          return { name: "minecraft:wall_banner", states: { facing_direction: 3 } };
        if (z === 10 && x === 4)
          return { name: "minecraft:vine", states: { vine_direction_bits: 1 } };
        if (z === 10 && (x === 20 || x === 40)) return "minecraft:waterlily";
        return "minecraft:air";
      }),
      biomeRecord(0, cx, 0, Array<number>(24).fill(cx < 2 ? 1 : 6)),
      bedEntityRecord(
        0,
        cx,
        0,
        Array.from({ length: 16 }, (_, base) => ({
          id: "Banner",
          x: 2 + base * 3,
          y: 64,
          z: 5,
          base,
        })).filter((entity) => entity.x >> 4 === cx),
      ),
    ]),
  );
  builder = new RegionBuilder({ directory, dimension: "overworld" });
});
afterAll(async () => {
  builder.close();
  await rm(directory, { recursive: true, force: true });
});

it.each([false, true])(
  "preserves saved cloth dyes, wood supports and green plant tint (textures=%s)",
  (textured) => {
    const region = decodeSceneRegion(
      builder.build({ level: 0, x: 0, z: 0, ...(textured ? { textures } : {}) }),
    );
    for (let base = 0; base < 16; base++) {
      const faces = Array.from({ length: region.opaque.length / 3 }, (_, i) => ({
        q: unpackQuad(region.opaque, i),
        word: region.textures?.opaque[i] ?? 0,
      })).filter(({ q }) => q.x === 2 + base * 3 && q.y === 64 && q.z === 5);
      const expected = resolveBlockAppearance(`minecraft:${DYES[15 - base]}_wool`, {}).top;
      expect(faces.some(({ q }) => q.color === expected)).toBe(true);
      expect(faces.some(({ q }) => q.color === 0xa2834f)).toBe(true);
      if (textured) {
        for (const { q, word } of faces) {
          if (q.color === expected)
            expect(unpackQuadTexture(word)).toMatchObject({ tile: 0, tinted: true });
          if (q.color === 0xa2834f) expect(word).toBe(0);
        }
      }
    }
    for (const x of [4, 20, 40]) {
      const i = Array.from({ length: region.opaque.length / 3 }, (_, i) => i).find((i) => {
        const q = unpackQuad(region.opaque, i);
        return q.x === x && q.y === 64 && q.z === 10 && (x === 4 || q.face === Face.PositiveY);
      })!;
      expect(i).toBeDefined();
      const color = unpackQuad(region.opaque, i).color;
      expect((color >> 8) & 255).toBeGreaterThan(color >> 16);
      if (textured) {
        const word = region.textures!.opaque[i]!;
        expect(unpackQuadTexture(word)!.tinted).toBe(true);
        expect(word & QUAD_CUTOUT).not.toBe(0);
      }
    }
  },
);

it("keeps cloth colored when the stack has only the vanilla wooden block placeholder", () => {
  const region = decodeSceneRegion(
    builder.build({
      level: 0,
      x: 0,
      z: 0,
      textures: { ...textures, fingerprint: "no-banner-sheet", tiles: { wood: 0 } },
    }),
  );
  for (let i = 0; i < region.opaque.length / 3; i++) {
    const q = unpackQuad(region.opaque, i);
    if (q.y === 64 && q.z === 5) expect(region.textures!.opaque[i]).toBe(0);
  }
});
