import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { openBedrockWorld } from "./node-world.js";

describe("openBedrockWorld", () => {
  it("rejects invalid render concurrency before reading the world", async () => {
    await expect(
      openBedrockWorld({ directory: "/not-read", renderConcurrency: 0 }),
    ).rejects.toThrow("renderConcurrency must be a positive integer");
  });

  it("loads neighboring biome records for a seam-free tile render", async () => {
    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-halo-"));
    try {
      const databaseDirectory = join(worldDirectory, "db");
      await mkdir(databaseDirectory);
      const subchunk = singleBlockSubchunk(15, 0, 4, 15, 0);
      await writeFile(
        join(databaseDirectory, "000001.log"),
        levelDbLog([subchunk, data2DChunk(15, 0, 1), data2DChunk(16, 0, 6)]),
      );

      const world = await openBedrockWorld({ directory: worldDirectory });
      const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
      const pixelOffset = 255 * 4;
      expect(tile.rgba[pixelOffset]).toBeLessThan(145);
      expect(tile.rgba[pixelOffset]).toBeGreaterThan(107);
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  });

  it("maps a solid-color detailed negative tile to its parent index tile", async () => {
    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-detail-"));
    try {
      const databaseDirectory = join(worldDirectory, "db");
      await mkdir(databaseDirectory);
      await writeFile(
        join(databaseDirectory, "000001.log"),
        levelDbLog([singleBlockSubchunk(-16, 0, 4, 0, 0)]),
      );

      const world = await openBedrockWorld({ directory: worldDirectory });
      const tile = await world.renderTile({ dimension: "overworld", z: 2, x: -4, y: 0 });
      const colors = new Set<string>();
      for (let pixelZ = 0; pixelZ < 4; pixelZ += 1) {
        for (let pixelX = 0; pixelX < 4; pixelX += 1) {
          const offset = (pixelZ * 256 + pixelX) * 4;
          colors.add(Array.from(tile.rgba.slice(offset, offset + 4)).join(","));
        }
      }

      expect(tile.bounds).toEqual({ minX: -256, minZ: 0, maxX: -192, maxZ: 64 });
      expect(colors).toEqual(new Set(["95,146,61,255"]));
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  });
});

function int32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function fixed64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

function varint(value: number): number[] {
  const result: number[] = [];
  while (value >= 0x80) {
    result.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  result.push(value);
  return result;
}

function levelDbLog(entries: Array<{ key: Uint8Array; value: Uint8Array }>): Uint8Array {
  const batch = new Uint8Array([
    ...fixed64(1n),
    entries.length & 0xff,
    0,
    0,
    0,
    ...entries.flatMap(({ key, value }) => [
      1,
      ...varint(key.byteLength),
      ...key,
      ...varint(value.byteLength),
      ...value,
    ]),
  ]);
  return new Uint8Array([0, 0, 0, 0, batch.byteLength & 0xff, batch.byteLength >>> 8, 1, ...batch]);
}

function singleBlockSubchunk(
  chunkX: number,
  chunkZ: number,
  subchunkY: number,
  localX: number,
  localZ: number,
) {
  const words = new Uint8Array(Math.ceil(4096 / 32) * 4);
  const blockIndex = localX * 256 + localZ * 16 + 15;
  words[Math.floor(blockIndex / 8)]! |= 1 << (blockIndex % 8);
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
  ]);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2f, subchunkY & 0xff]),
    value: new Uint8Array([9, 1, subchunkY & 0xff, 2, ...words, 2, 0, 0, 0, ...palette]),
  };
}

function nbtString(name: string, value: string): number[] {
  const encodedName = Array.from(new TextEncoder().encode(name));
  const encodedValue = Array.from(new TextEncoder().encode(value));
  return [8, encodedName.length, 0, ...encodedName, encodedValue.length, 0, ...encodedValue];
}

function data2DChunk(chunkX: number, chunkZ: number, biomeId: number) {
  const value = new Uint8Array(768);
  value.fill(biomeId, 512);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2d]),
    value,
  };
}
