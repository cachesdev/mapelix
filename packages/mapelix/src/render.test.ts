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
    expect(Array.from(rgba.slice(0, 4))).toEqual([92, 142, 63, 255]);
    expect(rgba[4]).toBeGreaterThan(rgba[0] ?? 0);
    expect(rgba[7]).toBe(255);
  });
});
