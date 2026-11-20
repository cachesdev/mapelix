import { expect, it } from "vitest";
import { cutBannerTile } from "./banner-tile.js";
import { BANNER_TILE } from "./banner-tile.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makePng, makeZip, packFiles } from "../../test/synthetic-pack.js";
import { openResourcePackStack } from "./resource-pack.js";
import { buildTextureAtlas } from "./texture-atlas.js";

it.each([
  [64, 1],
  [128, 2],
  [512, 1],
  [1024, 2],
])("crops cloth and excludes the pole and patterns from a %i-square sheet", (width, scale) => {
  const rgba = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++)
      rgba.set(
        x >= scale && x < 21 * scale && y >= scale && y < 41 * scale
          ? [x, y, 220, 255]
          : [255, 0, 0, 255],
        (y * width + x) * 4,
      );
  const tile = cutBannerTile({ width, height: width, rgba })!;
  expect(tile.width).toBe(16 * scale);
  for (let i = 0; i < tile.rgba.length; i += 4) expect(tile.rgba[i + 2]).toBe(220);
  expect(tile.rgba[0]).toBe(scale);
  expect(tile.rgba[1]).toBe(scale);
  expect(cutBannerTile({ width: 32, height: 32, rgba })).toBeUndefined();
});

it("adds entity cloth to the atlas and retains its source notice", async () => {
  const root = await mkdtemp(join(tmpdir(), "mapelix-banner-atlas-"));
  try {
    const path = join(root, "pack.zip");
    await writeFile(
      path,
      makeZip(
        packFiles({
          terrain: { stone: { textures: "textures/blocks/stone" } },
          blocks: { stone: { textures: "stone" } },
          images: {
            "textures/blocks/stone.png": makePng(16, [128, 128, 128, 255]),
            "textures/entity/banner/banner.png": makePng(64, [240, 240, 240, 255]),
          },
        }),
      ),
    );
    const built = await buildTextureAtlas(await openResourcePackStack([path]));
    expect(built.index.tiles[BANNER_TILE]).toBeDefined();
    expect(built.atlas.tiles[built.index.tiles[BANNER_TILE]!]!.average).toBe(0xf0f0f0);
    expect(built.notices[0]!.files).toContain("textures/entity/banner/banner.png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
