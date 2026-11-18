import { Face } from "../format.js";
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
   * `bottom`; the other faces read `side`, turned so the rectangle runs along the axis.
   */
  readonly axis?: "x" | "y" | "z";
  readonly side: SheetTexel;
  /** Defaults to `side`. */
  readonly top?: SheetTexel;
  /** Defaults to `top`. */
  readonly bottom?: SheetTexel;
}

const AXES = { x: 0, y: 1, z: 2 } as const;

/**
 * The texture coordinates a face reads without an offset, in sixteenths, as the textured
 * terrain shader computes them from the position: tops `(x, z)`, bottoms `(x, -z)`, sides
 * with the texture's top up and its left on the left seen from outside.
 */
function faceRange(bounds: ModelBounds, face: number): readonly [number, number, number, number] {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  switch (face) {
    case Face.PositiveY:
      return [x0, x1, z0, z1];
    case Face.NegativeY:
      return [x0, x1, -z1, -z0];
    case Face.PositiveX:
      return [-z1, -z0, -y1, -y0];
    case Face.NegativeX:
      return [z0, z1, -y1, -y0];
    case Face.PositiveZ:
      return [x0, x1, -y1, -y0];
    default:
      return [-x1, -x0, -y1, -y0];
  }
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
  // A side whose first coordinate runs along the axis turns once, so the rectangle runs along.
  const turns =
    faceAxis !== axis && ((axis === 0 && faceAxis !== 0) || (axis === 2 && faceAxis === 0)) ? 1 : 0;
  let [u0, u1, v0, v1] = faceRange(bounds, face);
  for (let turn = 0; turn < turns; turn++) [u0, u1, v0, v1] = [v0, v1, -u1, -u0];
  const across = (((texel[0] - u0) % 16) + 16) % 16;
  const down = (((texel[1] - v0) % 16) + 16) % 16;
  return withTextureOffset(withTextureRotation(word, turns), across, down);
}
