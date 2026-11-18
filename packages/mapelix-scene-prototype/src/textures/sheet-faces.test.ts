import { describe, expect, it } from "vitest";

import { Face } from "../format.js";
import type { ModelBounds } from "../model-boxes.js";
import { packQuadTexture, unpackQuadTexture } from "./atlas-format.js";
import { sheetFaceWord, type PartSheet } from "./sheet-faces.js";

const WORD = packQuadTexture(5, 0, false);
const FACES = [
  Face.PositiveX,
  Face.NegativeX,
  Face.PositiveY,
  Face.NegativeY,
  Face.PositiveZ,
  Face.NegativeZ,
];

/**
 * The texels a face reads, as the textured terrain shader computes them: coordinates from the
 * position, quarter turns `(u, v)` to `(v, -u)`, then the offset, wrapped to the tile.
 */
function readTexels(word: number, bounds: ModelBounds, face: number): Set<string> {
  const texture = unpackQuadTexture(word)!;
  const [across, down] = texture.offset ?? [0, 0];
  const axis = face >> 1;
  const plane = bounds[axis + ((face & 1) === 0 ? 3 : 0)]!;
  const [a, b] = [0, 1, 2].filter((other) => other !== axis);
  const texels = new Set<string>();
  for (let i = bounds[a!]! + 0.5; i < bounds[a! + 3]!; i += 1)
    for (let j = bounds[b!]! + 0.5; j < bounds[b! + 3]!; j += 1) {
      const p = [0, 0, 0];
      p[axis] = plane;
      p[a!] = i;
      p[b!] = j;
      const [x, y, z] = p as [number, number, number];
      let [u, v] = [
        [-z, -y],
        [z, -y],
        [x, z],
        [x, -z],
        [x, -y],
        [-x, -y],
      ][face]!;
      for (let turn = 0; turn < texture.rotation; turn++) [u, v] = [v!, -u!];
      const wrap = (value: number) => ((Math.floor(value) % 16) + 16) % 16;
      texels.add(`${wrap(u! + across)},${wrap(v! + down)}`);
    }
  return texels;
}

/** Every texel of the rectangle from `(x, y)`, `width` across and `height` down. */
function rectangle(x: number, y: number, width: number, height: number): Set<string> {
  const texels = new Set<string>();
  for (let i = 0; i < width; i++) for (let j = 0; j < height; j++) texels.add(`${x + i},${y + j}`);
  return texels;
}

describe("sheet faces", () => {
  it("reads a lantern body's sides and top from their rectangles", () => {
    const bounds: ModelBounds = [5, 0, 5, 11, 7, 11];
    const sheet: PartSheet = { side: [0, 2], top: [0, 9] };
    for (const face of [Face.PositiveX, Face.NegativeX, Face.PositiveZ, Face.NegativeZ])
      expect(
        readTexels(sheetFaceWord(WORD, bounds, face, sheet), bounds, face),
        `face ${face}`,
      ).toEqual(rectangle(0, 2, 6, 7));
    for (const face of [Face.PositiveY, Face.NegativeY])
      expect(
        readTexels(sheetFaceWord(WORD, bounds, face, sheet), bounds, face),
        `face ${face}`,
      ).toEqual(rectangle(0, 9, 6, 6));
  });

  it("reads a separate bottom when the sheet has one", () => {
    const bounds: ModelBounds = [7, 0, 7, 9, 6, 9];
    const sheet: PartSheet = { side: [0, 8], top: [0, 6], bottom: [0, 14] };
    const read = (face: number) =>
      readTexels(sheetFaceWord(WORD, bounds, face, sheet), bounds, face);
    expect(read(Face.PositiveY)).toEqual(rectangle(0, 6, 2, 2));
    expect(read(Face.NegativeY)).toEqual(rectangle(0, 14, 2, 2));
    expect(read(Face.PositiveZ)).toEqual(rectangle(0, 8, 2, 6));
  });

  it("turns the sides of a lying rod so they run along it", () => {
    const rods: readonly ["x" | "y" | "z", ModelBounds][] = [
      ["x", [0, 7, 7, 16, 9, 9]],
      ["y", [7, 0, 7, 9, 16, 9]],
      ["z", [7, 7, 0, 9, 9, 16]],
    ];
    for (const [axis, bounds] of rods) {
      const sheet: PartSheet = { axis, side: [0, 0], top: [2, 0] };
      const along = { x: 0, y: 1, z: 2 }[axis];
      for (const face of FACES) {
        const texels = readTexels(sheetFaceWord(WORD, bounds, face, sheet), bounds, face);
        expect(texels, `${axis} face ${face}`).toEqual(
          face >> 1 === along ? rectangle(2, 0, 2, 2) : rectangle(0, 0, 2, 16),
        );
      }
    }
  });

  it("keeps the rest of the word and leaves faces without a texture alone", () => {
    const tinted = packQuadTexture(9, 0, true);
    const word = sheetFaceWord(tinted, [5, 0, 5, 11, 7, 11], Face.PositiveZ, { side: [0, 2] });
    expect(unpackQuadTexture(word)).toMatchObject({ tile: 9, tinted: true, rotation: 0 });
    expect(sheetFaceWord(0, [5, 0, 5, 11, 7, 11], Face.PositiveZ, { side: [0, 2] })).toBe(0);
  });
});
