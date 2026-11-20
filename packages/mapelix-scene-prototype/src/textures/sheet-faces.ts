import type { ModelBounds } from "../model-boxes.js";
import { withTextureOffset, withTextureRotation } from "./atlas-format.js";

/** A texel of a sheet of parts, from its top left: across, then down. */
export type SheetTexel = readonly [number, number];

/**
 * Where the faces of one model part read a sheet of parts: the top left texel of each face's
 * rectangle, as the game draws it. A lantern's texture, for example, holds its body sides at
 * (0, 2), its top at (0, 9) and its cap at (1, 0).
 */
export interface PartSheet {
  /**
   * The part's long axis, `y` by default. Its two end faces read `top` (the positive end) and
   * `bottom`; the other faces read `side`, turned so the rectangle runs down the sheet from the
   * part's positive end, as a standing part reads it from its top.
   */
  readonly axis?: "x" | "y" | "z";
  /**
   * The side rectangle lies across the sheet instead, from the part's positive end on its
   * left, as a campfire log's bark does.
   */
  readonly across?: boolean;
  readonly side: SheetTexel;
  /** Defaults to `side`. */
  readonly top?: SheetTexel;
  /** Defaults to `top`. */
  readonly bottom?: SheetTexel;
}

const AXES = { x: 0, y: 1, z: 2 } as const;

type Vector = readonly [number, number, number];

/**
 * The texture coordinates a face reads without an offset, as the textured terrain shader
 * computes them from the position: each is the dot product of the position with a vector. Tops
 * read `(x, z)`, bottoms `(x, -z)`, sides with the texture's top up and its left on the left seen
 * from outside.
 */
const FACE_COORDINATES: readonly (readonly [Vector, Vector])[] = [
  // In `Face` order.
  [
    [0, 0, -1],
    [0, -1, 0],
  ], // PositiveX
  [
    [0, 0, 1],
    [0, -1, 0],
  ], // NegativeX
  [
    [1, 0, 0],
    [0, 0, 1],
  ], // PositiveY
  [
    [1, 0, 0],
    [0, 0, -1],
  ], // NegativeY
  [
    [1, 0, 0],
    [0, -1, 0],
  ], // PositiveZ
  [
    [-1, 0, 0],
    [0, -1, 0],
  ], // NegativeZ
];

const negate = (vector: Vector): Vector => [-vector[0], -vector[1], -vector[2]];

/** The lowest value of `vector · position` over the part. */
function lowest(vector: Vector, bounds: ModelBounds): number {
  let value = 0;
  for (let axis = 0; axis < 3; axis++) {
    const weight = vector[axis]!;
    value += weight * (weight > 0 ? bounds[axis]! : bounds[axis + 3]!);
  }
  return value;
}

/**
 * The texture word of one face of a part drawn from a sheet: its quarter turns, and the offset
 * that brings its top left texel onto the sheet's rectangle. The shader turns the coordinates
 * `(u, v)` into `(v, -u)` per quarter turn, then adds the offset, so the offset is computed in
 * the turned coordinates.
 */
export function sheetFaceWord(
  word: number,
  bounds: ModelBounds,
  face: number,
  sheet: PartSheet,
): number {
  if (word === 0) return 0;
  const axis = AXES[sheet.axis ?? "y"];
  const faceAxis = face >> 1;
  const top = sheet.top ?? sheet.side;
  const texel = faceAxis === axis ? ((face & 1) === 0 ? top : (sheet.bottom ?? top)) : sheet.side;
  let [u, v] = FACE_COORDINATES[face]!;
  let turns = 0;
  // A side turns until its second coordinate runs from the part's positive end, as `-y` does
  // on standing parts.
  if (faceAxis !== axis)
    while (v![axis] !== -1) {
      [u, v] = [v!, negate(u!)];
      turns += 1;
    }
  if (faceAxis !== axis && sheet.across === true) {
    [u, v] = [v!, negate(u!)];
    turns += 1;
  }
  const across = (((texel[0] - lowest(u!, bounds)) % 16) + 16) % 16;
  const down = (((texel[1] - lowest(v!, bounds)) % 16) + 16) % 16;
  return withTextureOffset(withTextureRotation(word, turns), across, down);
}
