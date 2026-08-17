import { describe, expect, it } from "vitest";

import { renderSurface } from "./render.js";
import { TILE_SIZE, type SurfaceBlock } from "./tile.js";

describe("renderSurface", () => {
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
    expect(Array.from(rgba.slice(0, 4))).toEqual([99, 158, 66, 255]);
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
    expect(Array.from(rgba.slice(0, 4))).toEqual([105, 111, 53, 255]);
    expect(rgba[4]).toBeLessThan(rgba[5] ?? 0);
    expect(rgba[7]).toBe(255);
  });

  it("blends biome tints only at the two blocks touching a boundary", () => {
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

    expect(new Set(colors).size).toBe(4);
    expect(colors[0]).toBe("145,193,85");
    expect(colors.at(-1)).toBe("107,114,54");
    expect(colors[1]).toBe(colors[0]);
    expect(colors[4]).toBe(colors[5]);
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
    expect(rgba[highIndex * 4]).toBeGreaterThan(rgba[lowIndex * 4] ?? 0);
    expect(rgba[highIndex * 4 + 1]).toBeLessThan(rgba[lowIndex * 4 + 1] ?? 0);
    expect(rgba[highIndex * 4 + 2]).toBeLessThan(rgba[lowIndex * 4 + 2] ?? 0);
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

  it("casts a bounded shadow southeast of raised terrain", () => {
    const exposed = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock | undefined => undefined,
    );
    const shadowed = [...exposed];
    const targetIndex = 3 * TILE_SIZE + 3;
    exposed[targetIndex] = { name: "minecraft:stone", y: 64 };
    shadowed[targetIndex] = { name: "minecraft:stone", y: 64 };
    shadowed[0] = { name: "minecraft:stone", y: 84 };

    const exposedRgba = renderSurface(exposed);
    const shadowedRgba = renderSurface(shadowed);
    expect(shadowedRgba[targetIndex * 4]).toBeLessThan(exposedRgba[targetIndex * 4] ?? 0);
    expect(shadowedRgba[targetIndex * 4 + 3]).toBe(255);
  });

  it("keeps a tall block shadow crisp instead of smearing it seven blocks", () => {
    const samples = Array.from(
      { length: TILE_SIZE * TILE_SIZE },
      (): SurfaceBlock => ({ name: "minecraft:stone", y: 64 }),
    );
    samples[10 * TILE_SIZE + 10] = { name: "minecraft:stone", y: 84 };

    const rgba = renderSurface(samples);
    const redAt = (x: number, z: number) => rgba[(z * TILE_SIZE + x) * 4]!;

    expect(redAt(11, 11)).toBeLessThan(redAt(9, 11));
    expect(redAt(14, 14)).toBe(redAt(13, 14));
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
    const targetIndex = 3 * TILE_SIZE + 3;
    const renderShadow = (sourceName: string | undefined) => {
      const samples = Array.from(
        { length: TILE_SIZE * TILE_SIZE },
        (): SurfaceBlock | undefined => undefined,
      );
      samples[targetIndex] = { name: "minecraft:stone", y: 64 };
      if (sourceName !== undefined) samples[0] = { name: sourceName, y: 84 };
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
