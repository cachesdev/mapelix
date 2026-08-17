import { describe, expect, it } from "vitest";

import { createBedrockWorld } from "./world.js";

function int32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function nbtString(name: string, value: string): number[] {
  const encodedName = Array.from(new TextEncoder().encode(name));
  const encodedValue = Array.from(new TextEncoder().encode(value));
  return [8, encodedName.length, 0, ...encodedName, encodedValue.length, 0, ...encodedValue];
}

function singleBlockSubchunk(
  chunkX: number,
  chunkZ: number,
  subchunkY: number,
  blockName: string,
  localX = 0,
  localZ = 0,
): { key: Uint8Array; value: Uint8Array } {
  const key = new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2f, subchunkY & 0xff]);
  const words = new Uint8Array(Math.ceil(4096 / 32) * 4);
  const palette = new Uint8Array([
    10,
    0,
    0,
    ...nbtString("name", "minecraft:air"),
    0,
    10,
    0,
    0,
    ...nbtString("name", blockName),
    0,
  ]);
  const blockIndex = localX * 256 + localZ * 16 + 15;
  words[Math.floor(blockIndex / 8)]! |= 1 << (blockIndex % 8);
  return {
    key,
    value: new Uint8Array([9, 1, subchunkY & 0xff, 2, ...words, 2, 0, 0, 0, ...palette]),
  };
}

function data2DChunk(chunkX: number, chunkZ: number, biomeId: number) {
  const value = new Uint8Array(768);
  value.fill(biomeId, 512);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2d]),
    value,
  };
}

function flatGroundSubchunk(withCover: boolean): { key: Uint8Array; value: Uint8Array } {
  const subchunkY = 4;
  const words = new Uint8Array(Math.ceil(4096 / 16) * 4);
  const view = new DataView(words.buffer);
  const setIndex = (blockIndex: number, paletteIndex: number) => {
    const wordIndex = Math.floor(blockIndex / 16);
    const shift = (blockIndex % 16) * 2;
    const word = view.getUint32(wordIndex * 4, true);
    view.setUint32(wordIndex * 4, word | (paletteIndex << shift), true);
  };
  for (let localZ = 0; localZ < 16; localZ += 1) {
    for (let localX = 0; localX < 16; localX += 1) {
      setIndex(localX * 256 + localZ * 16 + 14, 1);
    }
  }
  if (withCover) setIndex(8 * 256 + 8 * 16 + 15, 2);

  const palette = new Uint8Array([
    10,
    0,
    0,
    ...nbtString("name", "minecraft:air"),
    0,
    10,
    0,
    0,
    ...nbtString("name", "minecraft:grass_block"),
    0,
    10,
    0,
    0,
    ...nbtString("name", "minecraft:short_grass"),
    0,
  ]);
  return {
    key: new Uint8Array([...int32(0), ...int32(0), 0x2f, subchunkY]),
    value: new Uint8Array([9, 1, subchunkY, 4, ...words, 3, 0, 0, 0, ...palette]),
  };
}

describe("createBedrockWorld", () => {
  it("renders a decoded surface at the correct negative tile coordinate", async () => {
    const world = createBedrockWorld([singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block")]);
    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });

    const pixelOffset = 240 * 4;
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([107, 121, 43, 255]);
    expect(tile.bounds).toEqual({ minX: -256, minZ: 0, maxX: 0, maxZ: 256 });
    expect(Array.from(tile.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(world.getTileCoverage("overworld")).toEqual([{ x: -1, y: 0, subchunkCount: 1 }]);
  });

  it("applies a legacy Data2D biome to the matching chunk columns", async () => {
    const world = createBedrockWorld([
      singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block"),
      data2DChunk(-1, 0, 6),
    ]);

    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });
    const pixelOffset = 240 * 4;
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([116, 102, 39, 255]);
    expect(world.getTileCoverage("overworld")).toEqual([{ x: -1, y: 0, subchunkCount: 1 }]);
  });

  it("blends biome tint across a tile boundary using neighboring biome records", async () => {
    const world = createBedrockWorld([
      singleBlockSubchunk(15, 0, 4, "minecraft:grass_block", 15, 0),
      data2DChunk(15, 0, 1),
      data2DChunk(16, 0, 6),
    ]);

    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
    const pixelOffset = 255 * 4;
    expect(tile.rgba[pixelOffset]).toBeLessThan(145);
    expect(tile.rgba[pixelOffset]).toBeGreaterThan(107);
    expect(tile.rgba[pixelOffset + 1]).toBeLessThan(193);
    expect(tile.rgba[pixelOffset + 1]).toBeGreaterThan(114);
  });

  it("renders one untextured block color across four pixels at zoom two", async () => {
    const world = createBedrockWorld([singleBlockSubchunk(0, 0, 4, "minecraft:oak_leaves", 0, 0)]);

    const tile = await world.renderTile({ dimension: "overworld", z: 2, x: 0, y: 0 });
    const colors = new Set<string>();
    for (let pixelZ = 0; pixelZ < 4; pixelZ += 1) {
      for (let pixelX = 0; pixelX < 4; pixelX += 1) {
        const offset = (pixelZ * 256 + pixelX) * 4;
        colors.add(Array.from(tile.rgba.slice(offset, offset + 4)).join(","));
      }
    }

    expect(tile.bounds).toEqual({ minX: 0, minZ: 0, maxX: 64, maxZ: 64 });
    expect(colors).toEqual(new Set(["54,112,58,255"]));
    expect(tile.rgba[(4 * 256 + 4) * 4 + 3]).toBe(0);
  });

  it("does not let decorative cover alter its neighbor's terrain lighting", async () => {
    const plain = createBedrockWorld([flatGroundSubchunk(false)]);
    const covered = createBedrockWorld([flatGroundSubchunk(true)]);

    const plainTile = await plain.renderTile({ dimension: "overworld", z: 3, x: 0, y: 0 });
    const coveredTile = await covered.renderTile({ dimension: "overworld", z: 3, x: 0, y: 0 });
    const neighborOffset = ((8 * 8 + 4) * 256 + (9 * 8 + 4)) * 4;

    expect(Array.from(coveredTile.rgba.slice(neighborOffset, neighborOffset + 4))).toEqual(
      Array.from(plainTile.rgba.slice(neighborOffset, neighborOffset + 4)),
    );
  });
});
