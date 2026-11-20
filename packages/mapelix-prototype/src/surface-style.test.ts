import { describe, expect, it } from "vitest";
import { renderSurface } from "./render.js";
import { surfaceBlockStyle, type SurfaceStyle } from "./surface-style.js";
import type { SurfaceBlock } from "./tile.js";

const style: SurfaceStyle = {
  "minecraft:future_leaves": { color: { red: 160, green: 30, blue: 50, alpha: 255 } },
};
const field = (sample: SurfaceBlock) => Array.from({ length: 32 * 32 }, () => sample);
const interior = (rgba: Uint8Array) =>
  Array.from(rgba.slice((128 * 256 + 128) * 4, (128 * 256 + 129) * 4));

describe("declarative surface styles", () => {
  it("resolves the first matching state variant without retaining variants on a voxel", () => {
    const table: SurfaceStyle = {
      "minecraft:future_leaves": {
        ...style["minecraft:future_leaves"]!,
        variants: [
          { states: { lit: 1, powered: 1 }, color: { red: 1, green: 2, blue: 3, alpha: 255 } },
          { states: { lit: 1 }, color: { red: 4, green: 5, blue: 6, alpha: 255 } },
        ],
      },
    };
    const selected = surfaceBlockStyle(table, "minecraft:future_leaves", { lit: 1, powered: 1 });
    expect(selected?.color).toEqual({ red: 1, green: 2, blue: 3, alpha: 255 });
    expect(selected?.variants).toBeUndefined();
    expect(surfaceBlockStyle(table, "minecraft:future_leaves", {})?.color).toEqual(
      style["minecraft:future_leaves"]!.color,
    );
    expect(table["minecraft:future_leaves"]!.variants).toHaveLength(2);
  });

  it("ignores inherited object properties and unspecified names", () => {
    expect(surfaceBlockStyle(style, "toString")).toBeUndefined();
    expect(surfaceBlockStyle(style, "constructor")).toBeUndefined();
    expect(surfaceBlockStyle(style, "addon:future_leaves")).toBeUndefined();
  });

  it("keeps fixed colors through biome blending without removing grass tint", () => {
    const samples = field({ name: "minecraft:future_leaves", y: 62, biomeId: 1 });
    samples[0] = { name: "minecraft:grass_block", y: 62, biomeId: 1 };
    for (const biomeBlendRadius of [0, 2]) {
      expect(
        interior(renderSurface(samples, { surfaceStyle: style, biomeBlendRadius, shadows: false })),
      ).toEqual([160, 30, 50, 255]);
      const original = renderSurface(samples, { biomeBlendRadius, shadows: false });
      const modern = renderSurface(samples, {
        surfaceStyle: style,
        biomeBlendRadius,
        shadows: false,
      });
      expect(modern.slice(0, 4)).toEqual(original.slice(0, 4));
    }
  });

  it("does not retint a fixed layer when another translucent layer needs biome colors", () => {
    const colors = [1, 6].map((biomeId) =>
      interior(
        renderSurface(
          field({
            name: "minecraft:red_stained_glass",
            y: 64,
            biomeId,
            colorLayers: [
              { name: "minecraft:red_stained_glass", count: 1 },
              { name: "minecraft:future_leaves", count: 1 },
              { name: "minecraft:water", count: 1, fluidDepth: 1 },
            ],
          }),
          { surfaceStyle: style, shadows: false },
        ),
      ),
    );
    expect(colors).toEqual([
      [166, 29, 39, 255],
      [166, 29, 39, 255],
    ]);
  });

  it("gives the existing custom color resolver precedence over declarative colors", () => {
    const rgba = renderSurface(field({ name: "minecraft:future_leaves", y: 62, biomeId: 1 }), {
      surfaceStyle: style,
      shadows: false,
      resolveBlockStyle: () => ({ red: 21, green: 43, blue: 65, alpha: 255 }),
    });
    expect(interior(rgba)).toEqual([21, 43, 65, 255]);
  });

  it("retains legacy pixels when an override does not name the material", () => {
    for (const name of [
      "minecraft:grass_block",
      "minecraft:oak_leaves",
      "minecraft:water",
      "addon:future_leaves",
      "minecraft:unknown",
    ]) {
      const samples = field({ name, y: 62, biomeId: 1 });
      expect(renderSurface(samples, { surfaceStyle: style })).toEqual(renderSurface(samples));
    }
  });
});
