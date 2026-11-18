import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodePng } from "@mapelix/prototype/png";

import { makePng, makeZip, packFiles } from "../../test/synthetic-pack.js";
import {
  ATLAS_HEADER_BYTES,
  MAX_ATLAS_SIDE,
  atlasCellSize,
  atlasLevelSize,
  decodeTextureAtlas,
  encodeTextureAtlas,
  packQuadTexture,
  unpackQuadTexture,
} from "./atlas-format.js";
import { resolveBlockTextures } from "./block-textures.js";
import { resolveBlockAppearance } from "../blocks/block-appearance.js";
import { openResourcePackStack } from "./resource-pack.js";
import { buildTextureAtlas, textureNames } from "./texture-atlas.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-atlas-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A 32-pixel texture of four 16-pixel quadrants, to check averaging and placement. */
function quadrants(): Uint8Array {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const at = (y * 32 + x) * 4;
      pixels.set(
        x < 16 ? (y < 16 ? [255, 0, 0, 255] : [0, 255, 0, 255]) : [0, 0, 255, y < 16 ? 255 : 0],
        at,
      );
    }
  }
  return encodePng(pixels, 32, 32);
}

/** Four 16-pixel frames stacked vertically, each a gray level. */
function strip(): Uint8Array {
  const pixels = new Uint8Array(16 * 64 * 4);
  for (let y = 0; y < 64; y++) {
    const level = [10, 20, 30, 40][Math.floor(y / 16)]!;
    for (let x = 0; x < 16; x++) pixels.set([level, level, level, 255], (y * 16 + x) * 4);
  }
  return encodePng(pixels, 16, 64);
}

async function stackOf(): Promise<Awaited<ReturnType<typeof openResourcePackStack>>> {
  const path = join(root, "pack.zip");
  await writeFile(
    path,
    makeZip(
      packFiles({
        terrain: {
          stone: { textures: "textures/blocks/stone" },
          big: { textures: "textures/blocks/big" },
          water: { textures: "textures/blocks/water" },
          grass_top: { textures: "textures/blocks/grass_top" },
          gone: { textures: "textures/blocks/gone" },
        },
        blocks: {
          stone: { textures: "stone" },
          big: { textures: "big" },
          water: { textures: "water" },
          grass: { textures: { up: "grass_top", down: "stone", side: "stone" } },
          gone: { textures: "gone" },
        },
        flipbooks: [
          {
            flipbook_texture: "textures/blocks/water",
            atlas_tile: "water",
            ticks_per_frame: 3,
            frames: [3, 2, 1, 0],
          },
        ],
        images: {
          "textures/blocks/stone.png": makePng(16, [100, 110, 120, 255]),
          "textures/blocks/big.png": quadrants(),
          "textures/blocks/water.png": strip(),
          "textures/blocks/grass_top.png": makePng(16, [150, 150, 150, 255]),
        },
      }),
    ),
  );
  return openResourcePackStack([path]);
}

describe("texture atlas", () => {
  it("places every texture and animation frame in tiles of the common size", async () => {
    const built = await buildTextureAtlas(await stackOf());
    const { atlas, index } = built;
    expect(atlas.tileSize).toBe(16);
    // big, grass_top, stone, and four water frames; the missing image has no tile.
    expect(atlas.tiles).toHaveLength(7);
    expect(Object.keys(index.tiles).sort()).toEqual([
      "textures/blocks/big",
      "textures/blocks/grass_top",
      "textures/blocks/stone",
      "textures/blocks/water",
    ]);
    const water = index.tiles["textures/blocks/water"]!;
    expect(atlas.tiles[water]).toMatchObject({ frames: 4, ticksPerFrame: 3, average: 0x282828 });
    expect(
      atlas.tiles.slice(water + 1, water + 4).map((tile) => [tile.frames, tile.average]),
    ).toEqual([
      [0, 0x1e1e1e],
      [0, 0x141414],
      [0, 0x0a0a0a],
    ]);
    // A 32-pixel texture is averaged down; its transparent quadrant lowers the coverage.
    const big = atlas.tiles[index.tiles["textures/blocks/big"]!]!;
    expect(big.coverage).toBe(191);
    expect(atlas.tiles[index.tiles["textures/blocks/stone"]!]!.average).toBe(0x646e78);

    // Each mip level halves the cells, down to 4-pixel tiles with a 1-pixel gutter.
    expect(atlas.levels).toHaveLength(3);
    const stone = index.tiles["textures/blocks/stone"]!;
    const last = atlas.levels[2]!;
    const lastWidth = atlas.columns * 6;
    const at =
      (((stone / atlas.columns) | 0) * 6 + 3) * lastWidth + (stone % atlas.columns) * 6 + 3;
    expect(Array.from(last.subarray(at * 4, at * 4 + 4))).toEqual([100, 110, 120, 255]);

    // The gutter repeats the tile: left of the tile is its right edge, above it its bottom row.
    const width = atlas.columns * 24;
    const pixel = (tile: number, x: number, y: number): number[] => {
      const offset =
        ((((tile / atlas.columns) | 0) * 24 + 4 + y) * width +
          (tile % atlas.columns) * 24 +
          4 +
          x) *
        4;
      return Array.from(atlas.levels[0]!.subarray(offset, offset + 4));
    };
    const bigTile = index.tiles["textures/blocks/big"]!;
    expect(pixel(bigTile, -1, 0)).toEqual(pixel(bigTile, 15, 0));
    expect(pixel(bigTile, -4, -4)).toEqual(pixel(bigTile, 12, 12));
    expect(pixel(bigTile, 16, 19)).toEqual(pixel(bigTile, 0, 3));
    expect(pixel(bigTile, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(bigTile, -1, 0)).toEqual([0, 0, 255, 255]);
    expect(built.notices).toEqual([
      {
        pack: expect.objectContaining({ name: "Synthetic pack" }) as unknown,
        files: [
          "textures/blocks/big.png",
          "textures/blocks/grass_top.png",
          "textures/blocks/stone.png",
          "textures/blocks/water.png",
        ],
      },
    ]);
    expect(built.gpuBytes).toBe(atlas.levels.reduce((sum, level) => sum + level.byteLength, 0));

    // The index resolves blocks the way a region builder will.
    const grass = resolveBlockTextures(
      textureNames(index),
      "minecraft:grass_block",
      {},
      resolveBlockAppearance("minecraft:grass_block", {}),
    );
    expect(grass?.faces[2]).toEqual({
      path: "textures/blocks/grass_top",
      rotation: 0,
      tinted: true,
    });
  });

  it("takes images it cannot use from the next pack and lists them", async () => {
    const bottom = join(root, "bottom.zip");
    const files = (name: string, uuid: string, images: Record<string, Uint8Array>) =>
      makeZip(
        packFiles({
          name,
          uuid,
          terrain: {
            stone: { textures: "textures/blocks/stone" },
            water: { textures: "textures/blocks/water" },
            lava: { textures: "textures/blocks/lava" },
          },
          blocks: {
            stone: { textures: "stone" },
            water: { textures: "water" },
            lava: { textures: "lava" },
          },
          flipbooks: [{ flipbook_texture: "textures/blocks/water", atlas_tile: "water" }],
          images,
        }),
      );
    await writeFile(
      bottom,
      files("Bottom", "00000000-0000-4000-8000-0000000000b2", {
        "textures/blocks/stone.png": makePng(16, [100, 110, 120, 255]),
        "textures/blocks/water.png": makePng(16, [0, 0, 200, 255]),
        "textures/blocks/lava.png": makePng(16, [200, 80, 0, 255]),
      }),
    );
    // Water: a header that passes, but data cut short. Lava: taller than the limits allow.
    const top = join(root, "top.zip");
    await writeFile(
      top,
      files("Top", "00000000-0000-4000-8000-0000000000b3", {
        "textures/blocks/stone.png": makePng(16, [10, 20, 30, 255]),
        "textures/blocks/water.png": strip().slice(0, 60),
        "textures/blocks/lava.png": encodePng(new Uint8Array(16 * 128 * 4).fill(255), 16, 128),
      }),
    );
    const stack = await openResourcePackStack([top, bottom], { maxImageSide: 64 });
    const built = await buildTextureAtlas(stack);
    const [topInfo, bottomInfo] = stack.packs.map((pack) => pack.info);
    expect(built.skipped).toEqual([
      {
        pack: topInfo,
        file: "textures/blocks/lava.png",
        reason: "image is wider or taller than 64 pixels",
      },
      {
        pack: topInfo,
        file: "textures/blocks/water.png",
        reason: expect.stringMatching(/damaged PNG/),
      },
    ]);
    expect(built.notices).toEqual([
      { pack: topInfo, files: ["textures/blocks/stone.png"] },
      { pack: bottomInfo, files: ["textures/blocks/lava.png", "textures/blocks/water.png"] },
    ]);
    // The water layout counted the four frames of the cut strip; the bottom pack's single
    // frame fills them all.
    const water = built.index.tiles["textures/blocks/water"]!;
    expect(built.atlas.tiles[water]!.frames).toBe(4);
    const colors = built.atlas.tiles.slice(water, water + 4).map((tile) => tile.average);
    expect(new Set(colors).size).toBe(1);
  });

  it("encodes and decodes the same atlas, and builds the same bytes again", async () => {
    const stack = await stackOf();
    const first = await buildTextureAtlas(stack);
    const second = await buildTextureAtlas(stack);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.fingerprint).toBe(first.fingerprint);
    const decoded = decodeTextureAtlas(first.bytes);
    expect(decoded.tiles).toEqual(first.atlas.tiles);
    expect(decoded.levels.map((level) => level.byteLength)).toEqual(
      first.atlas.levels.map((level) => level.byteLength),
    );
    expect(() => decodeTextureAtlas(first.bytes.subarray(0, first.bytes.byteLength - 1))).toThrow(
      /bytes/,
    );
    const wrong = first.bytes.slice();
    wrong[0] = 0;
    expect(() => decodeTextureAtlas(wrong)).toThrow(/Not a Mapelix/);
    expect(() => decodeTextureAtlas(first.bytes.subarray(0, ATLAS_HEADER_BYTES - 1))).toThrow(
      /truncated/,
    );
  });

  it("shrinks tiles to the requested size and budget", async () => {
    const stack = await stackOf();
    const small = await buildTextureAtlas(stack, { maxTileSize: 8 });
    expect(small.atlas.levels).toHaveLength(2);
    expect(small.atlas.tileSize).toBe(8);
    expect(small.fingerprint).not.toBe((await buildTextureAtlas(stack)).fingerprint);
    const tight = await buildTextureAtlas(stack, { budgetBytes: 3000 });
    expect(tight.gpuBytes).toBeLessThanOrEqual(3000);
    expect(tight.atlas.tileSize).toBeLessThan(16);
    await expect(buildTextureAtlas(stack, { budgetBytes: 100 })).rejects.toThrow(/budget/);
    await expect(buildTextureAtlas(stack, { maxTileSize: 2 })).rejects.toThrow(/from 4 to 256/);
  });

  it("shrinks high-resolution tiles until the atlas fits the side every device samples", async () => {
    const images: Record<string, Uint8Array> = {};
    const terrain: Record<string, { textures: string }> = {};
    const blocks: Record<string, { textures: string }> = {};
    for (let index = 0; index < 500; index++) {
      images[`textures/blocks/hd_${index}.png`] = makePng(64, [index % 256, 0, 0, 255]);
      terrain[`hd_${index}`] = { textures: `textures/blocks/hd_${index}` };
      blocks[`hd_${index}`] = { textures: `hd_${index}` };
    }
    const path = join(root, "hd.zip");
    await writeFile(path, makeZip(packFiles({ terrain, blocks, images })));
    const built = await buildTextureAtlas(await openResourcePackStack([path]), {
      maxTileSize: 64,
    });
    // 23 columns of 96-pixel cells would be 2208 pixels wide; 48-pixel cells fit in 2048.
    expect(built.atlas.tileSize).toBe(32);
    expect(built.atlas.columns * 48).toBeLessThanOrEqual(MAX_ATLAS_SIDE);
  });

  it("keeps the colors under an overlay mask, whose alpha is not transparency", async () => {
    // Like a grass block side: a gray strip that takes the biome color (alpha 255) above soil
    // (alpha 0), whose color must survive in the tile and its mipmaps.
    const pixels = new Uint8Array(16 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++)
        pixels.set(y < 4 ? [150, 150, 150, 255] : [120, 80, 40, 0], (y * 16 + x) * 4);
    }
    const path = join(root, "overlay.zip");
    await writeFile(
      path,
      makeZip(
        packFiles({
          terrain: {
            grass_side: {
              textures: [{ path: "textures/blocks/grass_side", overlay_color: "#79c05a" }],
            },
            dirt: { textures: "textures/blocks/dirt" },
          },
          blocks: { grass: { textures: "grass_side" }, dirt: { textures: "dirt" } },
          images: {
            "textures/blocks/grass_side.png": encodePng(pixels, 16, 16),
            "textures/blocks/dirt.png": makePng(16, [120, 80, 40, 255]),
          },
        }),
      ),
    );
    const built = await buildTextureAtlas(await openResourcePackStack([path]));
    const decoded = decodeTextureAtlas(encodeTextureAtlas(built.atlas));
    const tile = built.index.tiles["textures/blocks/grass_side"]!;
    expect(decoded.tiles[tile]).toMatchObject({ overlay: true, coverage: 255 });
    expect(decoded.tiles[built.index.tiles["textures/blocks/dirt"]!]).not.toHaveProperty("overlay");
    // The last level holds 4-pixel tiles: soil rows stay soil although their alpha is 0.
    const level = decoded.levels.length - 1;
    const cell = atlasCellSize(decoded.tileSize) >> level;
    const { width } = atlasLevelSize(decoded, level);
    const x = (tile % decoded.columns) * cell + cell / 2;
    const y = Math.floor(tile / decoded.columns) * cell + cell - 2;
    expect([
      ...decoded.levels[level]!.subarray((y * width + x) * 4, (y * width + x) * 4 + 4),
    ]).toEqual([120, 80, 40, 0]);
  });

  it("packs a quad texture word", () => {
    const word = packQuadTexture(1234, 3, true);
    expect(unpackQuadTexture(word)).toEqual({ tile: 1234, rotation: 3, tinted: true });
    expect(unpackQuadTexture(packQuadTexture(0, 0, false))).toEqual({
      tile: 0,
      rotation: 0,
      tinted: false,
    });
    expect(unpackQuadTexture(0)).toBeUndefined();
  });
});
