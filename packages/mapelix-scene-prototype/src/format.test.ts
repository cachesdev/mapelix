import { describe, expect, it } from "vitest";

import {
  EMPTY_HEIGHT,
  Face,
  PlantSprite,
  QuadList,
  QuadMaterial,
  decodeSceneRegion,
  encodeSceneRegion,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  regionGridSize,
  unpackQuad,
} from "./format.js";

describe("scene region format", () => {
  it("packs every quad field into three words and reads them back", () => {
    const quads = new QuadList();
    const box = { size: 8, inset: 6, anchoredTop: true };
    quads.push(
      packQuadWord0(127, -64, 3, Face.NegativeZ, QuadMaterial.Plant, true),
      packQuadWord1(128, 384, box, PlantSprite.Mushroom),
      packQuadWord2(0xa1b2c3, 0b11_10_01_00),
    );

    expect(unpackQuad(quads.finish(), 0)).toEqual({
      x: 127,
      y: -64,
      z: 3,
      face: Face.NegativeZ,
      material: QuadMaterial.Plant,
      coveredSoil: true,
      width: 128,
      height: 384,
      box,
      sprite: PlantSprite.Mushroom,
      color: 0xa1b2c3,
      occlusion: 0b11_10_01_00,
    });
  });

  it("round-trips a region without copying its arrays on decode", () => {
    const heights = new Int16Array(regionGridSize(2) ** 2).fill(EMPTY_HEIGHT);
    heights[5] = 71;
    const region = {
      level: 2,
      x: -3,
      z: 7,
      heights,
      minY: -12,
      maxY: 140,
      opaque: new Uint32Array([1, 2, 3, 4, 5, 6]),
      plants: new Uint32Array(0),
      translucent: new Uint32Array([7, 8, 9]),
    };

    const encoded = encodeSceneRegion(region);
    const decoded = decodeSceneRegion(encoded);

    expect(decoded).toMatchObject({ ...region, originX: -768, originZ: 1792, cellSize: 2 });
    expect(decoded.opaque.buffer).toBe(encoded.buffer);
  });
});
