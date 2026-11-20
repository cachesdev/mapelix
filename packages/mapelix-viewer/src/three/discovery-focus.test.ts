import { describe, expect, it } from "vitest";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import {
  packDiscoveryBlock,
  type DiscoveryGroup,
  type DiscoveryTile,
} from "@mapelix/scene-prototype/discoveries";
import { discoveryContext, discoveryDistance, surfaceDiscoveryTiles } from "./discovery-focus";

const group = (y: number): DiscoveryGroup => ({
  dimension: "overworld",
  id: `test/${y}`,
  kind: 13,
  x: 14,
  y,
  z: 20,
  count: 1,
  exposed: 1,
  buried: 0,
  unknown: 0,
  minX: 14,
  maxX: 15,
  minY: y,
  maxY: y + 1,
  minZ: 20,
  maxZ: 21,
});

describe("discovery framing", () => {
  it("filters Surface cooperatively without changing cached all-height packets", () => {
    const blocks = Uint32Array.from({ length: 1024 }, (_, i) =>
      packDiscoveryBlock(i & 31, i % 2 ? 81 : -63, i >> 5, 13, "exposed"),
    );
    const original = blocks.slice(),
      tile: DiscoveryTile = { dimension: "overworld", x: 0, z: 0, sourceChunks: 15, blocks };
    const iterator = surfaceDiscoveryTiles([tile], (_x, y) => y === 81);
    let yields = 0;
    while (true) {
      const step = iterator.next();
      if (step.done) {
        expect(step.value[0]!.blocks).toHaveLength(512);
        break;
      }
      yields++;
    }
    expect(yields).toBe(4);
    expect(blocks).toEqual(original);
  });
  it("requires positive visibility and never accepts a shallow or unknown buried point", () => {
    expect(discoveryContext(group(77), sceneContext(), false)).toMatchObject({
      mode: "caves",
      minY: 48,
      maxY: 80,
    });
    expect(discoveryContext(group(81), sceneContext())).toMatchObject({ mode: "caves" });
  });
  it("keeps surface objects on Surface and opens a negative cave slice for deeply covered objects", () => {
    const surface = sceneContext();
    expect(discoveryContext(group(81), surface, true)).toEqual(surface);
    expect(discoveryContext(group(-63), surface, false)).toMatchObject({
      mode: "caves",
      minY: -64,
      maxY: -32,
    });
    expect(discoveryContext(group(-63), surface, false, 16)).toMatchObject({
      minY: -64,
      maxY: -48,
    });
  });
  it("retains cave thickness, compatible aliases and an already visible slice", () => {
    const caves = sceneContext("overworld", { mode: "caves", minY: -32, maxY: -16 });
    expect(discoveryContext(group(-24), caves)).toEqual(caves);
    expect(discoveryContext(group(-63), caves)).toMatchObject({
      minY: -64,
      maxY: -48,
      ceilingY: -48,
    });
    expect(discoveryContext(group(81), caves, true)).toMatchObject({
      mode: "caves",
      minY: 80,
      maxY: 96,
    });
  });
  it("approaches moderately, handles larger groups and never zooms out from a close view", () => {
    expect(discoveryDistance(group(81), 160)).toBe(18);
    expect(discoveryDistance({ ...group(81), maxX: 80 }, 160)).toBe(40);
    expect(discoveryDistance(group(81), 6)).toBe(6);
  });
  it("keeps a buried point in the upper section and backs the camera out above the cut", () => {
    const buried = { ...group(65), exposed: 0, buried: 1 };
    const context = discoveryContext(buried, sceneContext());
    expect(context).toMatchObject({ mode: "caves", minY: 48, maxY: 80 });
    const distance = discoveryDistance(buried, 6, { maxY: context.maxY, pitch: 0.9 });
    expect(distance).toBeGreaterThanOrEqual(18);
    expect(buried.y + Math.sin(0.9) * distance).toBeGreaterThan(context.maxY);
    expect(discoveryDistance(buried, 6, { maxY: 80, pitch: 0.15 })).toBe(96);
    const mixed = { ...buried, count: 2, exposed: 1 };
    expect(discoveryDistance(mixed, 6)).toBe(18);
    expect(discoveryDistance(mixed, 6, { maxY: 80, pitch: 0.9, exposed: true })).toBe(6);
  });
});
