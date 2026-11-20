import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caveFixtureRecords } from "../../test/cave-fixture.js";
import { dimensionFixtureRecords, writeFixtureWorld } from "../../test/dimension-fixture.js";
import { contextFromSearch, contextKey, contextSearch, sceneContext } from "../dimensions.js";
import { decodeSceneRegion, Face, unpackQuad } from "../format.js";
import { RegionBuilder } from "./region-builder.js";

describe("canonical underground windows", () => {
  let directory: string, builder: RegionBuilder;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-caves-"));
    await writeFixtureWorld(directory, [...dimensionFixtureRecords(), ...caveFixtureRecords()]);
    builder = new RegionBuilder({ directory, dimension: "overworld" });
  });
  afterAll(async () => {
    builder?.close();
    await rm(directory, { recursive: true, force: true });
  });

  it.each([0, 1])("keeps enclosed negative-Y tunnel floors and ceilings at LOD %i", (level) => {
    const request = { mode: "caves" as const, minY: -64, maxY: -32, level, x: 0, z: 0 };
    const region = decodeSceneRegion(builder.build(request));
    const faces = Array.from({ length: region.opaque.length / 3 }, (_, i) =>
      unpackQuad(region.opaque, i),
    );
    expect(faces.some((q) => q.y === -49 && q.face === Face.PositiveY)).toBe(true);
    expect(faces.some((q) => q.y === -46 && q.face === Face.NegativeY)).toBe(true);
    expect(faces.every((q) => q.y >= -64 && q.y < -32)).toBe(true);
    expect(region.minY).toBeLessThan(0);
    expect(region.maxY).toBeLessThanOrEqual(-32);
    const boundaryTops = faces.filter((q) => q.y === -33 && q.face === Face.PositiveY);
    expect(boundaryTops.length).toBeGreaterThan(0);
    expect(boundaryTops.every((q) => q.z === 16 && q.height === 1)).toBe(true);
    const surface = decodeSceneRegion(builder.build({ level, x: 0, z: 0 }));
    expect(
      Array.from({ length: surface.opaque.length / 3 }, (_, i) =>
        unpackQuad(surface.opaque, i),
      ).some((q) => q.y === -46 && q.face === Face.NegativeY),
    ).toBe(false);
    const { maxY, ...alias } = request;
    expect(builder.build({ ...alias, ceilingY: maxY })).toEqual(builder.build(request));
  });

  it("normalizes aliases and separates equal-bound visibility strategies", () => {
    const legacy = sceneContext("overworld", -32);
    expect(legacy.maxY).toBe(-32);
    expect(contextKey(legacy)).toBe(contextKey(sceneContext("overworld", { maxY: -32 })));
    const caves = sceneContext("overworld", { mode: "caves", minY: -64, maxY: -32 });
    expect(contextKey(caves)).not.toBe(contextKey(legacy));
    expect(contextFromSearch(contextSearch(caves))).toEqual(caves);
    expect(sceneContext("overworld", { mode: "caves" })).toEqual(caves);
    expect(() => sceneContext("overworld", { maxY: 0, ceilingY: 16 })).toThrow("agree");
    for (const maxY of [-33, -64, 320, Infinity])
      expect(() => sceneContext("overworld", { mode: "caves", minY: -64, maxY })).toThrow(
        RangeError,
      );
    expect(() =>
      builder.build({ mode: "caves", minY: -64, maxY: -32, level: 2, x: 0, z: 0 }),
    ).toThrow("LOD");
  });

  it("supports the 16-block slice and does not contaminate the shared Surface builder", () => {
    const surface = builder.build({ level: 0, x: 0, z: 0 });
    const thin = decodeSceneRegion(
      builder.build({ mode: "caves", minY: -64, maxY: -48, level: 0, x: 0, z: 0 }),
    );
    expect(thin.opaque.length).toBeGreaterThan(0);
    expect(thin.maxY).toBeLessThanOrEqual(-48);
    expect(builder.build({ level: 0, x: 0, z: 0 })).toEqual(surface);
  });
});
