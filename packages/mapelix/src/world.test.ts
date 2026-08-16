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
  // Bedrock index x=0,z=0,y=15 is the fifteenth bit in the first word.
  words[1] = 0x80;
  return {
    key,
    value: new Uint8Array([9, 1, subchunkY & 0xff, 2, ...words, 2, 0, 0, 0, ...palette]),
  };
}

describe("createBedrockWorld", () => {
  it("renders a decoded surface at the correct negative tile coordinate", async () => {
    const world = createBedrockWorld([singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block")]);
    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });

    const pixelOffset = 240 * 4;
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([92, 142, 63, 255]);
    expect(tile.bounds).toEqual({ minX: -256, minZ: 0, maxX: 0, maxZ: 256 });
    expect(Array.from(tile.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
