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
  localY = 15,
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
  const blockIndex = localX * 256 + localZ * 16 + localY;
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

function data3DChunk(
  chunkX: number,
  chunkZ: number,
  biomeId: number,
): { key: Uint8Array; value: Uint8Array } {
  const sections = [1, ...int32(biomeId), 0xff];
  const value = new Uint8Array(512 + sections.length);
  value.set(sections, 512);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2b]),
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

function stackedSubchunk(
  blockNames: readonly string[] = ["minecraft:red_stained_glass", "minecraft:white_wool"],
): { key: Uint8Array; value: Uint8Array } {
  const subchunkY = 4;
  const words = new Uint8Array(Math.ceil(4096 / 8) * 4);
  const view = new DataView(words.buffer);
  const setIndex = (localY: number, paletteIndex: number) => {
    const blockIndex = localY;
    const wordIndex = Math.floor(blockIndex / 8);
    const shift = (blockIndex % 8) * 4;
    const word = view.getUint32(wordIndex * 4, true);
    view.setUint32(wordIndex * 4, word | (paletteIndex << shift), true);
  };
  blockNames.forEach((_, index) => setIndex(15 - index, index + 1));

  const paletteEntries = blockNames.flatMap((name) => [10, 0, 0, ...nbtString("name", name), 0]);
  const palette = new Uint8Array([
    10,
    0,
    0,
    ...nbtString("name", "minecraft:air"),
    0,
    ...paletteEntries,
  ]);
  return {
    key: new Uint8Array([...int32(0), ...int32(0), 0x2f, subchunkY]),
    value: new Uint8Array([
      9,
      1,
      subchunkY,
      8,
      ...words,
      blockNames.length + 1,
      0,
      0,
      0,
      ...palette,
    ]),
  };
}

describe("createBedrockWorld", () => {
  it("renders a decoded surface at the correct negative tile coordinate", async () => {
    const world = createBedrockWorld([singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block")]);
    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });

    const pixelOffset = 240 * 4;
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([107, 120, 42, 255]);
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
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([91, 96, 51, 255]);
    expect(world.getTileCoverage("overworld")).toEqual([{ x: -1, y: 0, subchunkCount: 1 }]);
  });

  it("uses the Data3D biome at the visible block height before the Data2D fallback", async () => {
    const world = createBedrockWorld([
      singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block"),
      data2DChunk(-1, 0, 1),
      data3DChunk(-1, 0, 29),
    ]);

    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });
    const pixelOffset = 240 * 4;
    expect(Array.from(tile.rgba.slice(pixelOffset, pixelOffset + 4))).toEqual([68, 104, 43, 255]);
  });

  it("can include decoded XYZ-ready surface metadata for diagnostics", async () => {
    const world = createBedrockWorld([
      singleBlockSubchunk(-1, 0, 4, "minecraft:grass_block"),
      data3DChunk(-1, 0, 192),
    ]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: -1, y: 0 },
      { includeSurface: true, shadows: false },
    );

    expect(tile.surface?.sampleSize).toBe(256);
    expect(tile.surface?.samples[240]).toMatchObject({
      name: "minecraft:grass_block",
      y: 79,
      biomeId: 192,
    });
  });

  it("decodes legacy minecraft:grass as opaque terrain instead of decorative cover", async () => {
    const world = createBedrockWorld([stackedSubchunk(["minecraft:grass", "minecraft:dirt"])]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { includeSurface: true, shadows: false },
    );
    const surface = tile.surface?.samples[0];

    expect(surface).toMatchObject({
      name: "minecraft:grass",
      y: 79,
      shadowRuns: [{ minY: 78, maxY: 79, opacity: 1 }],
    });
    expect(surface).not.toHaveProperty("supportY");
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

  it.each([
    { axis: "X", zoom: 1, receiverX: 0, receiverZ: 1, occluderX: -1, occluderZ: 0 },
    { axis: "X", zoom: 2, receiverX: 0, receiverZ: 1, occluderX: -1, occluderZ: 0 },
    { axis: "X", zoom: 3, receiverX: 0, receiverZ: 1, occluderX: -1, occluderZ: 0 },
    { axis: "Z", zoom: 1, receiverX: 1, receiverZ: 0, occluderX: 0, occluderZ: -1 },
    { axis: "Z", zoom: 2, receiverX: 1, receiverZ: 0, occluderX: 0, occluderZ: -1 },
    { axis: "Z", zoom: 3, receiverX: 1, receiverZ: 0, occluderX: 0, occluderZ: -1 },
  ])(
    "casts a shadow across the $axis native tile boundary at zoom $zoom",
    async ({ zoom, receiverX, receiverZ, occluderX, occluderZ }) => {
      const world = createBedrockWorld([
        singleBlockSubchunk(0, 0, 4, "minecraft:stone", receiverX, receiverZ),
        singleBlockSubchunk(
          Math.floor(occluderX / 16),
          Math.floor(occluderZ / 16),
          5,
          "minecraft:stone",
          (occluderX + 16) % 16,
          (occluderZ + 16) % 16,
          1,
        ),
      ]);

      const coordinates = { dimension: "overworld" as const, z: zoom, x: 0, y: 0 };
      const [lit, shadowed] = await Promise.all([
        world.renderTile(coordinates, { shadows: false }),
        world.renderTile(coordinates),
      ]);
      const pixelsPerBlock = 2 ** zoom;
      const receiverRed = (tile: typeof lit) =>
        Array.from({ length: pixelsPerBlock * pixelsPerBlock }, (_, index) => {
          const pixelX = receiverX * pixelsPerBlock + (index % pixelsPerBlock);
          const pixelZ = receiverZ * pixelsPerBlock + Math.floor(index / pixelsPerBlock);
          return tile.rgba[(pixelZ * 256 + pixelX) * 4];
        });

      expect(receiverRed(shadowed)).not.toEqual(receiverRed(lit));
    },
  );

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

  it("composites stained glass over the visible block below it", async () => {
    const world = createBedrockWorld([stackedSubchunk()]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { includeSurface: true, shadows: false },
    );

    expect(Array.from(tile.rgba.slice(0, 4))).toEqual([200, 128, 128, 255]);
    expect(tile.surface?.samples[0]).toMatchObject({
      name: "minecraft:red_stained_glass",
      y: 79,
      colorLayers: [
        { name: "minecraft:red_stained_glass", count: 1 },
        { name: "minecraft:white_wool", count: 1 },
      ],
    });
  });

  it("uses the dye palette for concrete below stained glass", async () => {
    const world = createBedrockWorld([
      stackedSubchunk(["minecraft:black_stained_glass", "minecraft:gray_concrete"]),
    ]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { shadows: false },
    );

    expect(Array.from(tile.rgba.slice(0, 4))).toEqual([56, 56, 56, 255]);
  });

  it("uses the biome-independent water color when biome data is absent", async () => {
    const world = createBedrockWorld([
      stackedSubchunk(["minecraft:water", "minecraft:gray_concrete"]),
    ]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { shadows: false },
    );

    expect(Array.from(tile.rgba.slice(0, 4))).toEqual([33, 84, 161, 255]);
  });

  it("composites shallow water over nonblocking cover below glass", async () => {
    const world = createBedrockWorld([
      stackedSubchunk([
        "minecraft:red_stained_glass",
        "minecraft:water",
        "minecraft:seagrass",
        "minecraft:sand",
      ]),
      data2DChunk(0, 0, 43),
    ]);

    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { includeSurface: true, shadows: false },
    );

    expect(Array.from(tile.rgba.slice(0, 4))).toEqual([110, 80, 95, 255]);
    expect(tile.surface?.samples[0]?.colorLayers).toEqual([
      { name: "minecraft:red_stained_glass", count: 1 },
      {
        name: "minecraft:water",
        count: 1,
        fluidDepth: 1,
        underwaterName: "minecraft:seagrass",
      },
    ]);
  });

  it("colors a consecutive glass run once", async () => {
    const deepWater = Array.from({ length: 13 }, () => "minecraft:water");
    const single = createBedrockWorld([
      stackedSubchunk(["minecraft:red_stained_glass", ...deepWater, "minecraft:sand"]),
      data2DChunk(0, 0, 43),
    ]);
    const double = createBedrockWorld([
      stackedSubchunk([
        "minecraft:red_stained_glass",
        "minecraft:red_stained_glass",
        ...deepWater,
        "minecraft:sand",
      ]),
      data2DChunk(0, 0, 43),
    ]);

    const [singleTile, doubleTile] = await Promise.all([
      single.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 }, { shadows: false }),
      double.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 }, { shadows: false }),
    ]);

    expect(Array.from(doubleTile.rgba.slice(0, 4))).toEqual(
      Array.from(singleTile.rgba.slice(0, 4)),
    );
    expect(Array.from(singleTile.rgba.slice(0, 4))).toEqual([97, 65, 115, 255]);
  });
});
