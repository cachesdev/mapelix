import { describe, expect, it } from "vitest";
import { Face, PlantSprite, QuadMaterial } from "../format.js";
import { BlockPalette } from "../mesh/block-palette.js";
import { resolveBlockAppearance } from "./block-appearance.js";

describe("sampled Bedrock block colors", () => {
  it.each([
    ["amethyst_block", 0x8662bf],
    ["sulfur", 0xbeaf66],
    ["cinnabar", 0x98534e],
    ["nether_gold_ore", 0x73372a],
    ["quartz_ore", 0x76423e],
    ["end_bricks", 0xdae0a2],
    ["dragon_egg", 0x0d0910],
  ] as const)("uses the official texture mean for %s", (name, top) => {
    expect(resolveBlockAppearance(`minecraft:${name}`, {})).toMatchObject({
      shape: { kind: "cube", material: QuadMaterial.Solid },
      top,
      tint: "none",
    });
  });

  it("retains different bone ends and sides along the stored pillar axis", () => {
    const appearance = resolveBlockAppearance("minecraft:bone_block", { pillar_axis: "x" });
    expect(appearance).toMatchObject({
      top: 0xd2ceb3,
      side: 0xe5e2d0,
      bottom: 0xd2ceb3,
      axis: "x",
    });
    const palette = new BlockPalette();
    const id = palette.idFor("minecraft:bone_block", { pillar_axis: "x" });
    expect(palette.colors[id * 6 + Face.PositiveX]).toBe(0xd2ceb3);
    expect(palette.colors[id * 6 + Face.PositiveY]).toBe(0xe5e2d0);
  });

  it("distinguishes oxidized copper from fresh copper, including waxed variants", () => {
    const fresh = resolveBlockAppearance("minecraft:copper_block", {});
    const oxidized = resolveBlockAppearance("minecraft:waxed_oxidized_copper", {});
    expect(fresh.top).toBe(0xc06c50);
    expect(oxidized.top).toBe(0x52a385);
    expect(resolveBlockAppearance("minecraft:waxed_copper", {}).top).toBe(fresh.top);
  });

  it("retains sampled colors while distinguishing lava fluid from solid magma", () => {
    const lava = resolveBlockAppearance("minecraft:lava", {});
    const magma = resolveBlockAppearance("minecraft:magma", {});
    expect(lava.shape).toEqual({ kind: "lava", level: 0 });
    expect(magma.shape).toEqual({ kind: "cube", material: QuadMaterial.Emissive });
    expect(lava.top).toBe(0xd55b13);
    expect(magma.top).toBe(0x8f3f20);
    expect(lava.top).not.toBe(lava.side);
  });

  it("colors red and brown mushrooms independently without changing their sprite", () => {
    const red = resolveBlockAppearance("minecraft:red_mushroom", {});
    const brown = resolveBlockAppearance("minecraft:brown_mushroom", {});
    expect(red.shape).toEqual({ kind: "plant", sprite: PlantSprite.Mushroom });
    expect(brown.shape).toEqual(red.shape);
    expect(red.top).not.toBe(brown.top);
  });

  it("retains carpet geometry and resolves legacy dye states", () => {
    const carpet = resolveBlockAppearance("minecraft:carpet", { color: "yellow" });
    expect(carpet).toEqual(resolveBlockAppearance("minecraft:yellow_carpet", {}));
    expect(carpet.shape).toMatchObject({ kind: "box", box: { size: 1, inset: 0 } });
    expect(carpet.top).not.toBe(0xd8d8d8);
  });

  it("maps Bedrock's unqualified oak gate to the existing oak appearance", () => {
    expect(resolveBlockAppearance("minecraft:fence_gate", {})).toEqual(
      resolveBlockAppearance("minecraft:oak_fence_gate", {}),
    );
  });

  it("samples every bed blanket independently, retaining wood only on the underside", () => {
    const colors = Array.from({ length: 16 }, (_, color) =>
      resolveBlockAppearance("minecraft:bed", { color }),
    );
    expect(new Set(colors.map((color) => color.top)).size).toBe(16);
    expect(colors[0]).toMatchObject({ top: 0xd7d4cd, bottom: 0xa2834f });
    expect(colors[14]?.top).toBe(0xb06359);
    expect(resolveBlockAppearance("minecraft:bed", {})).toEqual(colors[0]);
    const palette = new BlockPalette();
    expect(palette.idFor("minecraft:bed", { color: 0 })).not.toBe(
      palette.idFor("minecraft:bed", { color: 14 }),
    );
  });

  it("distinguishes the remaining Nether color families and crop stages", () => {
    expect(resolveBlockAppearance("minecraft:nether_brick", {}).top).toBe(0x2c161a);
    expect(resolveBlockAppearance("minecraft:red_nether_brick", {}).top).toBe(0x460709);
    expect(resolveBlockAppearance("minecraft:soul_sand", {}).top).not.toBe(
      resolveBlockAppearance("minecraft:soul_soil", {}).top,
    );
    const young = resolveBlockAppearance("minecraft:nether_wart", { age: 0 });
    const mature = resolveBlockAppearance("minecraft:nether_wart", { age: 3 });
    expect(young.top).toBe(0x761316);
    expect(mature.top).not.toBe(young.top);
    expect(mature.shape).toEqual(young.shape);
    const palette = new BlockPalette();
    expect(palette.idFor("minecraft:nether_wart", { age: 0 })).not.toBe(
      palette.idFor("minecraft:nether_wart", { age: 3 }),
    );
  });

  it("retains three distinct froglight colors and their emissive material", () => {
    const lights = ["ochre", "verdant", "pearlescent"].map((name) =>
      resolveBlockAppearance(`minecraft:${name}_froglight`, {}),
    );
    expect(new Set(lights.map((light) => light.top)).size).toBe(3);
    for (const light of lights)
      expect(light.shape).toEqual({ kind: "cube", material: QuadMaterial.Emissive });
  });

  it("does not paint cracked blackstone gray or group fungi with roots", () => {
    const blackstone = resolveBlockAppearance("minecraft:cracked_polished_blackstone_bricks", {});
    expect((blackstone.top >> 16) & 255).toBeLessThan(80);
    const fungus = resolveBlockAppearance("minecraft:warped_fungus", {});
    const roots = resolveBlockAppearance("minecraft:warped_roots", {});
    expect(fungus.top).not.toBe(roots.top);
    expect(fungus.shape).toEqual(roots.shape);
  });

  it.each(["scaffolding", "straw_bed"])("uses source textures for %s instead of gray", (name) => {
    expect(resolveBlockAppearance(`minecraft:${name}`, {}).top).not.toBe(0xd8d8d8);
  });

  it("does not apply vanilla texture samples to an add-on's block with the same local name", () => {
    expect(resolveBlockAppearance("example:amethyst_block", {}).top).toBe(0xd8d8d8);
    expect(resolveBlockAppearance("example:unknown_crystal", {}).top).toBe(0xd8d8d8);
  });

  it("keeps distinct cached colors for lit/powered bulbs and grown mushrooms", () => {
    const palette = new BlockPalette();
    const bulb = "minecraft:waxed_oxidized_copper_bulb";
    const off = palette.idFor(bulb, { lit: 0, powered_bit: 0 });
    const lit = palette.idFor(bulb, { lit: 1, powered_bit: 0 });
    const powered = palette.idFor(bulb, { lit: 1, powered_bit: 1 });
    expect(new Set([off, lit, powered]).size).toBe(3);
    expect(palette.colors[off * 6 + Face.PositiveY]).not.toBe(
      palette.colors[lit * 6 + Face.PositiveY],
    );
    expect(palette.idFor(bulb, { lit: 1, powered_bit: 0, irrelevant_state: 17 })).toBe(lit);
    const small = palette.idFor("minecraft:shelf_mushroom", { growth: 0 });
    const large = palette.idFor("minecraft:shelf_mushroom", { growth: 1 });
    expect(small).not.toBe(large);
    expect(palette.colors[small * 6 + Face.PositiveY]).not.toBe(
      palette.colors[large * 6 + Face.PositiveY],
    );
  });

  it("selects ominous spawner and vault samples before their ordinary state variants", () => {
    for (const [block, states] of [
      ["trial_spawner", { trial_spawner_state: 1 }],
      ["vault", { vault_state: "active" }],
    ] as const) {
      const normal = resolveBlockAppearance(`minecraft:${block}`, { ...states, ominous: 0 });
      const ominous = resolveBlockAppearance(`minecraft:${block}`, { ...states, ominous: 1 });
      expect(normal.top).not.toBe(ominous.top);
      expect(normal.shape).toEqual(ominous.shape);
    }
  });
});
