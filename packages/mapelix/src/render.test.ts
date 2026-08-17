import { describe, expect, it } from "vitest";

import { renderSurface } from "./render.js";
import { TILE_SIZE, type SurfaceBlock } from "./tile.js";

describe("renderSurface", () => {
  it.each([256, 128, 64, 32])(
    "keeps a uniform flat grass field uniform at sample size %i",
    (sampleSize) => {
      const samples = Array.from(
        { length: sampleSize * sampleSize },
        (): SurfaceBlock => ({ name: "minecraft:grass_block", y: 64, biomeId: 1 }),
      );

      const rgba = renderSurface(samples);
      const first = rgba.slice(0, 4);
      expect(rgba.every((channel, index) => channel === first[index % 4])).toBe(true);
    },
  );

  it("keeps block interiors flat and confines height lighting to edge pixels", () => {
    const sampleSize = 32;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:iron_block", y: 64 }),
    );
    samples[16 * sampleSize + 17] = { name: "minecraft:iron_block", y: 80 };

    const rgba = renderSurface(samples, {
      resolveBlockStyle: () => ({ red: 100, green: 100, blue: 100, alpha: 255 }),
    });
    const reds = Array.from({ length: pixelsPerBlock }, (_, localX) => {
      const x = 17 * pixelsPerBlock + localX;
      const z = 16 * pixelsPerBlock + Math.floor(pixelsPerBlock / 2);
      return rgba[(z * TILE_SIZE + x) * 4]!;
    });

    expect(reds[0]).toBeGreaterThan(100);
    expect(new Set(reds.slice(1))).toEqual(new Set([100]));
  });

  it("stores a shared height contour in exactly one output pixel", () => {
    const sampleSize = 64;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (_, index): SurfaceBlock => ({
        name: "minecraft:iron_block",
        y: index % sampleSize < sampleSize / 2 ? 64 : 65,
      }),
    );

    const rgba = renderSurface(samples, {
      resolveBlockStyle: () => ({ red: 100, green: 100, blue: 100, alpha: 255 }),
    });
    const boundaryX = (sampleSize / 2) * pixelsPerBlock;
    const outputZ = 20 * pixelsPerBlock + 2;
    const reds = Array.from(
      { length: pixelsPerBlock * 2 },
      (_, offset) => rgba[(outputZ * TILE_SIZE + boundaryX - pixelsPerBlock + offset) * 4]!,
    );
    const changedPixels = reds
      .map((red, index) => ({ red, index }))
      .filter(({ red }) => red !== 100);

    expect(changedPixels).toHaveLength(1);
    expect(changedPixels[0]?.index).toBe(pixelsPerBlock);
  });

  it("combines the north and west contour gains at a raised corner", () => {
    const sampleSize = 64;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:iron_block", y: 64 }),
    );
    const blockX = 16;
    const blockZ = 16;
    samples[blockZ * sampleSize + blockX] = { name: "minecraft:iron_block", y: 65 };

    const rgba = renderSurface(samples, {
      resolveBlockStyle: () => ({ red: 100, green: 100, blue: 100, alpha: 255 }),
    });
    const corner = (blockZ * pixelsPerBlock * TILE_SIZE + blockX * pixelsPerBlock) * 4;

    expect(rgba[corner]).toBe(169);
  });

  it("lights decorative cover from its supporting ground height", () => {
    const sampleSize = 32;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:grass_block", y: 64, biomeId: 1 }),
    );
    const covered = [...samples];
    covered[16 * sampleSize + 16] = {
      name: "minecraft:short_grass",
      y: 65,
      supportY: 64,
      biomeId: 1,
    };

    const plainRgba = renderSurface(samples);
    const coveredRgba = renderSurface(covered);
    const neighborX = 17 * 8 + 4;
    const neighborZ = 16 * 8 + 4;
    const neighborOffset = (neighborZ * TILE_SIZE + neighborX) * 4;

    expect(Array.from(coveredRgba.slice(neighborOffset, neighborOffset + 4))).toEqual(
      Array.from(plainRgba.slice(neighborOffset, neighborOffset + 4)),
    );
  });

  it("leaves missing world data transparent", () => {
    const rgba = renderSurface(
      Array.from({ length: TILE_SIZE * TILE_SIZE }, (): SurfaceBlock | undefined => undefined),
    );
    expect(rgba.every((channel) => channel === 0)).toBe(true);
  });

  it("renders block color and height relief", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    samples[0] = { name: "minecraft:grass_block", y: 64 };
    samples[1] = { name: "minecraft:grass_block", y: 72 };

    const rgba = renderSurface(samples);
    expect(Array.from(rgba.slice(0, 4))).toEqual([100, 150, 65, 255]);
    expect(rgba[4]).toBeGreaterThan(rgba[0] ?? 0);
    expect(rgba[7]).toBe(255);
  });

  it("applies biome colors to vegetation and transparent water", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    samples[0] = { name: "minecraft:grass_block", y: 64, biomeId: 6 };
    samples[1] = {
      name: "minecraft:water",
      y: 63,
      biomeId: 6,
      fluidDepth: 3,
      underwaterName: "minecraft:sand",
    };

    const rgba = renderSurface(samples);
    expect(Array.from(rgba.slice(0, 4))).toEqual([91, 94, 46, 255]);
    expect(rgba[4]).toBeLessThan(rgba[5] ?? 0);
    expect(rgba[7]).toBe(255);
  });

  it("keeps biome tint boundaries discrete", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (_, index): SurfaceBlock => ({
        name: "minecraft:grass_block",
        y: 64,
        biomeId: index % TILE_SIZE < 128 ? 1 : 6,
      }),
    );

    const rgba = renderSurface(samples);
    const colors = Array.from({ length: 6 }, (_, offset) => {
      const pixel = (100 * TILE_SIZE + 125 + offset) * 4;
      return `${rgba[pixel]},${rgba[pixel + 1]},${rgba[pixel + 2]}`;
    });

    expect(new Set(colors).size).toBe(2);
    expect(colors[0]).toBe("145,184,86");
    expect(colors.at(-1)).toBe("108,111,55");
    expect(colors.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => colors[0]));
    expect(colors.slice(3)).toEqual(Array.from({ length: 3 }, () => colors[5]));
  });

  it("shifts natural terrain from green toward ochre with altitude", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const lowIndex = 10 * TILE_SIZE + 10;
    const highIndex = 200 * TILE_SIZE + 200;
    samples[lowIndex] = { name: "minecraft:grass_block", y: 64, biomeId: 1 };
    samples[highIndex] = { name: "minecraft:grass_block", y: 160, biomeId: 1 };

    const rgba = renderSurface(samples);
    expect(rgba[highIndex * 4]! / rgba[highIndex * 4 + 1]!).toBeGreaterThan(
      rgba[lowIndex * 4]! / rgba[lowIndex * 4 + 1]!,
    );
    expect(rgba[highIndex * 4 + 1]).toBeLessThan(rgba[lowIndex * 4 + 1] ?? 0);
    expect(rgba[highIndex * 4 + 2]).toBeLessThan(rgba[lowIndex * 4 + 2] ?? 0);
  });

  it("applies the cartographic sea-to-mountain elevation style only to ground", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const seaIndex = 10 * TILE_SIZE + 10;
    const mountainIndex = 40 * TILE_SIZE + 200;
    const leavesIndex = 200 * TILE_SIZE + 40;
    samples[seaIndex] = { name: "minecraft:grass_block", y: 62 };
    samples[mountainIndex] = { name: "minecraft:grass_block", y: 112 };
    samples[leavesIndex] = { name: "minecraft:oak_leaves", y: 112 };

    const rgba = renderSurface(samples, {
      resolveBlockStyle: () => ({ red: 100, green: 100, blue: 100, alpha: 255 }),
    });

    expect(Array.from(rgba.slice(seaIndex * 4, seaIndex * 4 + 4))).toEqual([100, 100, 100, 255]);
    expect(Array.from(rgba.slice(mountainIndex * 4, mountainIndex * 4 + 4))).toEqual([
      134, 83, 7, 255,
    ]);
    expect(Array.from(rgba.slice(leavesIndex * 4, leavesIndex * 4 + 4))).toEqual([
      100, 100, 100, 255,
    ]);
  });

  it("keeps dirt paths brown while applying only elevation lightness", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const pathIndex = 100 * TILE_SIZE + 100;
    samples[pathIndex] = { name: "minecraft:dirt_path", y: 112 };

    const rgba = renderSurface(samples);

    expect(Array.from(rgba.slice(pathIndex * 4, pathIndex * 4 + 4))).toEqual([106, 78, 35, 255]);
  });

  it.each([
    ["minecraft:oak_stairs", [178, 137, 76, 255]],
    ["minecraft:spruce_planks", [110, 76, 42, 255]],
    ["minecraft:dark_oak_slab", [98, 63, 28, 255]],
    ["minecraft:stone_bricks", [127, 127, 127, 255]],
  ] as const)("keeps artificial roof material %s at its style color", (name, expected) => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const index = 100 * TILE_SIZE + 100;
    samples[index] = { name, y: 112 };

    const rgba = renderSurface(samples, { shadows: false });

    expect(Array.from(rgba.slice(index * 4, index * 4 + 4))).toEqual(expected);
  });

  it("lights terrain from a four-neighbor surface normal", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const flatIndex = 30 * TILE_SIZE + 30;
    const slopeIndex = 80 * TILE_SIZE + 80;
    for (const [x, z] of [
      [30, 30],
      [29, 30],
      [31, 30],
      [30, 29],
      [30, 31],
      [80, 80],
      [79, 80],
      [80, 79],
      [80, 81],
    ]) {
      samples[z! * TILE_SIZE + x!] = { name: "minecraft:stone", y: 64 };
    }
    samples[80 * TILE_SIZE + 81] = { name: "minecraft:stone", y: 80 };

    const rgba = renderSurface(samples);
    expect(rgba[slopeIndex * 4]).toBeGreaterThan(rgba[flatIndex * 4] ?? 0);
  });

  it("casts the shadow south-southeast for the published 120-degree sun", () => {
    const sampleSize = 64;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );
    samples[20 * sampleSize + 20] = { name: "minecraft:stone", y: 68 };

    const rgba = renderSurface(samples);
    const blockReds = (blockX: number, blockZ: number) =>
      Array.from({ length: pixelsPerBlock * pixelsPerBlock }, (_, pixel) => {
        const x = blockX * pixelsPerBlock + (pixel % pixelsPerBlock);
        const z = blockZ * pixelsPerBlock + Math.floor(pixel / pixelsPerBlock);
        return rgba[(z * TILE_SIZE + x) * 4]!;
      });
    const expectedRay = blockReds(21, 23);
    const wrongDiagonal = blockReds(22, 21);

    expect(Math.min(...expectedRay)).toBeLessThan(Math.max(...expectedRay));
    expect(Math.min(...expectedRay)).toBeLessThan(Math.min(...wrongDiagonal));
  });

  it("matches the native zoom-2 opaque shadow mask", () => {
    const sampleSize = 64;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );
    const blockX = 20;
    const blockZ = 20;
    samples[(blockZ - 1) * sampleSize + blockX] = { name: "minecraft:stone", y: 65 };

    const lit = renderSurface(samples, { shadows: false });
    const shaded = renderSurface(samples);
    const mask = Array.from({ length: pixelsPerBlock }, (_, pixelZ) =>
      Array.from({ length: pixelsPerBlock }, (_, pixelX) => {
        const x = blockX * pixelsPerBlock + pixelX;
        const z = blockZ * pixelsPerBlock + pixelZ;
        const offset = (z * TILE_SIZE + x) * 4;
        return shaded[offset]! < lit[offset]! ? "#" : ".";
      }).join(""),
    );

    expect(mask).toEqual(["####", ".###", ".###", "...."]);
  });

  it("smooths foliage opacity by each subpixel ray chord", () => {
    const sampleSize = 64;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );
    const blockX = 20;
    const blockZ = 20;
    samples[(blockZ - 1) * sampleSize + blockX] = { name: "minecraft:oak_leaves", y: 65 };

    const lit = renderSurface(samples, { shadows: false });
    const shaded = renderSurface(samples);
    const gains = Array.from({ length: pixelsPerBlock }, (_, pixelZ) =>
      Array.from({ length: pixelsPerBlock }, (_, pixelX) => {
        const x = blockX * pixelsPerBlock + pixelX;
        const z = blockZ * pixelsPerBlock + pixelZ;
        const offset = (z * TILE_SIZE + x) * 4;
        return shaded[offset]! / lit[offset]!;
      }),
    );

    expect(gains[0]?.[0]).toBeCloseTo(0.6 + 0.4 * 0.936_603, 2);
    expect(gains[0]?.[2]).toBeCloseTo(0.6 + 0.4 * 0.484_259, 2);
    expect(gains[1]?.[0]).toBeCloseTo(1, 2);
    expect(gains[2]?.[1]).toBeCloseTo(0.6 + 0.4 * 0.983_013, 2);
    expect(gains[3]).toEqual([1, 1, 1, 1]);
  });

  it("casts a bounded shadow southeast of raised terrain", () => {
    const exposed = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const shadowed = [...exposed];
    const targetIndex = 2 * TILE_SIZE + 1;
    exposed[targetIndex] = { name: "minecraft:stone", y: 64 };
    shadowed[targetIndex] = { name: "minecraft:stone", y: 64 };
    shadowed[0] = { name: "minecraft:stone", y: 84 };

    const exposedRgba = renderSurface(exposed);
    const shadowedRgba = renderSurface(shadowed);
    expect(shadowedRgba[targetIndex * 4]).toBeLessThan(exposedRgba[targetIndex * 4] ?? 0);
    expect(shadowedRgba[targetIndex * 4 + 3]).toBe(255);
  });

  it("keeps a tall block shadow on the sun axis instead of smearing it diagonally", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );
    samples[10 * TILE_SIZE + 10] = { name: "minecraft:stone", y: 84 };

    const rgba = renderSurface(samples);
    const redAt = (x: number, z: number) => rgba[(z * TILE_SIZE + x) * 4]!;

    expect(redAt(11, 12)).toBeLessThan(redAt(12, 11));
    expect(redAt(18, 24)).toBeLessThan(redAt(24, 18));
  });

  it("uses a stable shadow tone for one-block and tall height steps", () => {
    const renderShadow = (sourceHeight: number) => {
      const samples = Array.from(
        { length: TILE_SIZE * TILE_SIZE },
        (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
      );
      samples[10 * TILE_SIZE + 10] = { name: "minecraft:stone", y: sourceHeight };
      return renderSurface(samples)[(11 * TILE_SIZE + 11) * 4]!;
    };

    expect(Math.abs(renderShadow(65) - renderShadow(84))).toBeLessThanOrEqual(2);
  });

  it("uses a stable edge highlight for one-block and tall height steps", () => {
    const renderRaisedBlock = (sourceHeight: number) => {
      const samples = Array.from(
        { length: TILE_SIZE * TILE_SIZE },
        (): SurfaceBlock => ({ name: "minecraft:iron_block", y: 64 }),
      );
      const sourceIndex = 10 * TILE_SIZE + 10;
      samples[sourceIndex] = { name: "minecraft:iron_block", y: sourceHeight };
      return renderSurface(samples)[sourceIndex * 4]!;
    };

    expect(Math.abs(renderRaisedBlock(65) - renderRaisedBlock(84))).toBeLessThanOrEqual(2);
  });

  it("casts a softer shadow through foliage than through solid terrain", () => {
    const targetIndex = 2 * TILE_SIZE + 1;
    const renderShadow = (sourceName: string | undefined) => {
      const samples = Array.from(
        { length: TILE_SIZE * TILE_SIZE },
        (): SurfaceBlock | undefined => undefined,
      );
      samples[targetIndex] = { name: "minecraft:stone", y: 64 };
      if (sourceName !== undefined) samples[0] = { name: sourceName, y: 66 };
      return renderSurface(samples)[targetIndex * 4]!;
    };

    const exposed = renderShadow(undefined);
    const foliage = renderShadow("minecraft:oak_leaves");
    const solid = renderShadow("minecraft:stone");
    expect(solid).toBeLessThan(foliage);
    expect(foliage).toBeLessThan(exposed);
  });

  it("does not add a repeated diagonal seam to flat detailed blocks", () => {
    const sampleSize = 32;
    const pixelsPerBlock = TILE_SIZE / sampleSize;
    const samples = Array.from(
      { length: sampleSize * sampleSize },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );

    const rgba = renderSurface(samples);
    const averageAt = (localX: number, localZ: number) => {
      let sum = 0;
      for (let blockZ = 0; blockZ < sampleSize; blockZ += 1) {
        for (let blockX = 0; blockX < sampleSize; blockX += 1) {
          const x = blockX * pixelsPerBlock + localX;
          const z = blockZ * pixelsPerBlock + localZ;
          sum += rgba[(z * TILE_SIZE + x) * 4]!;
        }
      }
      return sum / samples.length;
    };

    expect(Math.abs(averageAt(0, 0) - averageAt(7, 7))).toBeLessThan(2);
  });
});
