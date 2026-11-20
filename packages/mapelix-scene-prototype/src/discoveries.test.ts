import { describe, expect, it } from "vitest";
import { BEDROCK_BLOCK_COLORS } from "./blocks/bedrock-colors.js";
import {
  DISCOVERY_KINDS,
  DEFAULT_DISCOVERY_FILTERS,
  decodeDiscoveryTile,
  discoveryCacheKey,
  discoveryFilterSearch,
  discoveryFiltersFromSearch,
  discoveryKind,
  encodeDiscoveryTile,
  packDiscoveryBlock,
  queryDiscoveries,
  queryDiscoverySteps,
  type DiscoveryTile,
} from "./discoveries.js";

describe("snapshot discovery packets and queries", () => {
  it("yields large grouping jobs and keeps only the nearest bounded marker set", () => {
    const words: number[] = [];
    for (let x = 0; x < 32; x += 2)
      for (let z = 0; z < 32; z += 2) words.push(packDiscoveryBlock(x, -40, z, 6, "buried"));
    const tile: DiscoveryTile = {
      dimension: "overworld",
      x: 0,
      z: 0,
      sourceChunks: 15,
      blocks: Uint32Array.from(words),
    };
    const filters = {
      ...DEFAULT_DISCOVERY_FILTERS,
      enabled: true,
      categories: ["ores"] as const,
      ores: ["diamond"],
    };
    const focus = { x: 30, y: -40, z: 30 };
    const job = queryDiscoverySteps([tile], filters, { minY: -64, maxY: -32 }, focus);
    let step = job.next(),
      yields = 0;
    while (!step.done) {
      yields++;
      step = job.next();
    }
    expect(yields).toBeGreaterThan(0);
    expect(step.value.matchingBlocks).toBe(256);
    expect(step.value.groups).toHaveLength(128);
    expect(step.value.groups[0]).toMatchObject({ x: 30, z: 30 });
    expect(step.value.limited).toBe(true);
  });
  it("covers every sampled vanilla ore and classifies all host/lit variants", () => {
    const names = Object.keys(BEDROCK_BLOCK_COLORS).filter(
      (name) => name.endsWith("_ore") || name === "ancient_debris",
    );
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(discoveryKind(`minecraft:${name}`), name).toBeDefined();
    expect(discoveryKind("minecraft:lit_redstone_ore")).toBe(
      discoveryKind("minecraft:deepslate_redstone_ore"),
    );
    expect(discoveryKind("minecraft:red_shulker_box")).toBe(discoveryKind("minecraft:shulker_box"));
    expect(discoveryKind("example:diamond_ore")).toBeUndefined();
  });
  it("round trips negative coordinates and rejects corrupt or incompatible payloads", () => {
    const tile: DiscoveryTile = {
      dimension: "overworld",
      x: -1,
      z: -1,
      sourceChunks: 15,
      blocks: Uint32Array.from([packDiscoveryBlock(31, -64, 31, 6, "buried")]),
    };
    const bytes = encodeDiscoveryTile(tile);
    expect(decodeDiscoveryTile(bytes)).toEqual(tile);
    for (const offset of [0, 4, 8, 20, 24, 28]) {
      const corrupt = bytes.slice();
      new DataView(corrupt.buffer).setUint32(offset, 999, true);
      expect(() => decodeDiscoveryTile(corrupt)).toThrow();
    }
    const corrupt = bytes.slice();
    new DataView(corrupt.buffer).setUint32(32, 0xffff_ffff, true);
    expect(() => decodeDiscoveryTile(corrupt)).toThrow();
    expect(() => decodeDiscoveryTile(bytes.subarray(0, 31))).toThrow();
    expect(discoveryCacheKey("snapshot-a", "overworld", tile)).not.toBe(
      discoveryCacheKey("snapshot-b", "overworld", tile),
    );
  });
  it("joins veins across region boundaries and applies depth, exposure, ore and area filters", () => {
    const a: DiscoveryTile = {
      dimension: "overworld",
      x: -1,
      z: 0,
      sourceChunks: 15,
      blocks: Uint32Array.from([
        packDiscoveryBlock(31, -40, 8, 6, "buried"),
        packDiscoveryBlock(30, -40, 8, 6, "exposed"),
      ]),
    };
    const b: DiscoveryTile = {
      ...a,
      x: 0,
      blocks: Uint32Array.from([
        packDiscoveryBlock(0, -40, 8, 6, "buried"),
        packDiscoveryBlock(1, -40, 8, 6, "unknown"),
        packDiscoveryBlock(4, -10, 8, 6, "buried"),
      ]),
    };
    const filters = {
      ...DEFAULT_DISCOVERY_FILTERS,
      enabled: true,
      categories: ["ores"] as const,
      ores: ["diamond"],
    };
    const focus = { x: 0, y: -40, z: 8 },
      window = { minY: -64, maxY: -32 };
    const result = queryDiscoveries([a, b], filters, window, focus);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      count: 4,
      exposed: 1,
      buried: 2,
      unknown: 1,
      minX: -2,
      maxX: 2,
    });
    expect(
      queryDiscoveries([a, b], { ...filters, exposure: "buried" }, window, focus).matchingBlocks,
    ).toBe(2);
    expect(
      queryDiscoveries([a, b], { ...filters, allHeights: true }, window, focus).matchingBlocks,
    ).toBe(5);
    expect(
      queryDiscoveries([a, b], filters, window, focus, { minX: 0, maxX: 16, minZ: 0, maxZ: 16 })
        .matchingBlocks,
    ).toBe(2);
    expect(
      queryDiscoveries([a, b], { ...filters, ores: ["iron"] }, window, focus).matchingBlocks,
    ).toBe(0);
    expect(queryDiscoveries([a], DEFAULT_DISCOVERY_FILTERS, window, focus).groups).toEqual([]);
  });
  it("retains all supported ore types and restores explicit shareable filters", () => {
    const filters = {
      ...DEFAULT_DISCOVERY_FILTERS,
      enabled: true,
      categories: ["ores", "vaults"] as const,
      ores: ["diamond", "ancient_debris"],
      exposure: "buried" as const,
      allHeights: true,
    };
    expect(discoveryFiltersFromSearch(discoveryFilterSearch(filters))).toEqual(filters);
    expect(
      discoveryFiltersFromSearch(discoveryFilterSearch({ ...filters, enabled: false })),
    ).toEqual({ ...filters, enabled: false });
    expect(discoveryFiltersFromSearch(new URLSearchParams())).toBeUndefined();
    expect(() => discoveryFiltersFromSearch(new URLSearchParams("discover=invalid"))).toThrow();
    expect(DISCOVERY_KINDS.length).toBeLessThanOrEqual(64);
  });
});
