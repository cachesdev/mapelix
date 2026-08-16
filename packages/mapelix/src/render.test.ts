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
    expect(Array.from(rgba.slice(0, 4))).toEqual([91, 145, 60, 255]);
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
    expect(Array.from(rgba.slice(0, 4))).toEqual([107, 114, 54, 255]);
    expect(rgba[4]).toBeLessThan(rgba[5] ?? 0);
    expect(rgba[7]).toBe(255);
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
});
