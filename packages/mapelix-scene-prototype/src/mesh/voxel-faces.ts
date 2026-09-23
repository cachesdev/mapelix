import { Face, QuadMaterial, type QuadBox } from "../format.js";

/**
 * Face bookkeeping shared by the block mesher and the voxel level mesher. Both keep
 * their cells y-major in a square volume: `layer * size * size + z * size + x`.
 */

/** How far below a column's roof, in blocks, the sky trace follows open air under eaves and trees. */
export const COVER_DEPTH = 32;
/**
 * How far around a column, in blocks, the sky trace looks for lower land. Air under a
 * platform or bridge stays open down to that land, so the ground under platforms up to
 * twice this wide stays drawn.
 */
export const COVER_REACH = 32;

/** Cell index steps along each face's normal and tangents, in `Face` order. */
export interface FaceSteps {
  readonly normal: readonly number[];
  /** The column step of each face; top and bottom faces stay in their column. */
  readonly column: readonly number[];
  readonly tangentU: readonly number[];
  readonly tangentV: readonly number[];
}

/** Layer steps along each face's normal, in `Face` order. */
export const NORMAL_LAYER = [0, 0, 1, -1, 0, 0] as const;

/**
 * Steps for a volume `size` cells wide. Faces on the x and z axes use (z, y) and
 * (x, y) as tangents; top and bottom faces use (x, z).
 */
export function faceSteps(size: number): FaceSteps {
  const layer = size * size;
  return {
    normal: [1, -1, layer, -layer, size, -size],
    column: [1, -1, 0, 0, size, -size],
    tangentU: [size, size, 1, 1, 1, 1],
    tangentV: [layer, layer, size, size, layer, layer],
  };
}

/** Occlusion corners in quad order: (0, 0), (1, 0), (1, 1), (0, 1) along the tangents. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

/**
 * Four corner occlusion levels from the opaque cells around the cell in front of a face.
 * `isSolid` receives a cell index and its layer, which may lie outside the volume.
 */
export function cornerOcclusion(
  steps: FaceSteps,
  face: number,
  front: number,
  frontLayer: number,
  isSolid: (index: number, layer: number) => boolean,
): number {
  const uStep = steps.tangentU[face]!;
  const vStep = steps.tangentV[face]!;
  const vIsLayer = !isFlatFace(face);
  let packed = 0;
  for (let corner = 0; corner < 4; corner += 1) {
    const [su, sv] = CORNERS[corner]!;
    const sideLayer = vIsLayer ? frontLayer + sv : frontLayer;
    const side1 = isSolid(front + su * uStep, frontLayer);
    const side2 = isSolid(front + sv * vStep, sideLayer);
    const diagonal = isSolid(front + su * uStep + sv * vStep, sideLayer);
    const level = side1 && side2 ? 0 : 3 - Number(side1) - Number(side2) - Number(diagonal);
    packed |= level << (corner * 2);
  }
  return packed;
}

/** Top and bottom faces lie flat; their slices run along y and their masks along x and z. */
export function isFlatFace(face: number): boolean {
  return face === Face.PositiveY || face === Face.NegativeY;
}

/** Mask dimensions for one face direction. Flat faces slice along y; the others along x or z. */
export interface SliceLayout {
  readonly span: number;
  readonly slices: number;
  readonly uSize: number;
  readonly vSize: number;
  readonly area: number;
}

/** Layout for faces of a region `span` cells wide and `height` layers tall. */
export function sliceLayout(face: number, span: number, height: number): SliceLayout {
  const flat = isFlatFace(face);
  const vSize = flat ? span : height;
  return { span, slices: flat ? height : span, uSize: span, vSize, area: span * vSize };
}

// Slice and in-slice mask index of a region cell, with `y` relative to the lowest slice.
// Masks are always `span` cells wide along u.
export function maskSlice(face: number, x: number, y: number, z: number): number {
  if (isFlatFace(face)) return y;
  return face === Face.PositiveX || face === Face.NegativeX ? x : z;
}

export function maskOffset(face: number, span: number, x: number, y: number, z: number): number {
  if (isFlatFace(face)) return z * span + x;
  return y * span + (face === Face.PositiveX || face === Face.NegativeX ? z : x);
}

/** Region-local cell position of mask cell (u, v) in a slice. */
export function slicePosition(
  face: number,
  slice: number,
  u: number,
  v: number,
  low: number,
): readonly [number, number, number] {
  if (isFlatFace(face)) return [u, low + slice, v];
  if (face === Face.PositiveX || face === Face.NegativeX) return [slice, low + v, u];
  return [u, low + v, slice];
}

const KEY_PRESENT = 1 << 31;
const KEY_SINGLE = 1 << 30;
const KEY_STACKS = 1 << 29;
const KEY_NARROW = 1 << 28;
/** Set on keys of covered-soil sides. */
export const KEY_COVERED = 1 << 27;

/**
 * Everything but position and size, so equal keys can merge into one quad. An inset
 * applies to each quad's outline, so inset boxes never widen, and their tops never
 * merge. Side faces stack vertically only for full-height boxes, such as fence posts.
 */
export function mergeKey(
  material: number,
  size: number,
  inset: number,
  anchoredTop: boolean,
  face: number,
): number {
  const flat = isFlatFace(face);
  const single = inset > 0 && flat;
  const narrow = inset > 0;
  const stacks = !flat && size === 16;
  return (
    ((size - 1) |
      (inset << 4) |
      ((anchoredTop ? 1 : 0) << 7) |
      (material << 8) |
      (single ? KEY_SINGLE : 0) |
      (narrow ? KEY_NARROW : 0) |
      (stacks ? KEY_STACKS : 0) |
      KEY_PRESENT) >>>
    0
  );
}

export function keyMaterial(key: number): QuadMaterial {
  const material = (key >>> 8) & 0xf;
  if (material > QuadMaterial.Plant) throw new RangeError(`Invalid material ${material}`);
  return material as QuadMaterial;
}

export function keyBox(key: number): QuadBox {
  return { size: (key & 0xf) + 1, inset: (key >>> 4) & 0x7, anchoredTop: ((key >>> 7) & 1) === 1 };
}

/** Receives one merged rectangle of a slice, in mask cells. */
export type EmitRectangle = (
  key: number,
  color: number,
  u: number,
  v: number,
  width: number,
  height: number,
) => void;

/** Merges equal neighboring faces of one slice mask into rectangles, clearing the mask. */
export function mergeSlice(
  face: number,
  keys: Uint32Array,
  colors: Uint32Array,
  layout: SliceLayout,
  emit: EmitRectangle,
): void {
  const { uSize, vSize } = layout;
  const flat = isFlatFace(face);
  for (let v = 0; v < vSize; v += 1) {
    for (let u = 0; u < uSize; u += 1) {
      const start = v * uSize + u;
      const key = keys[start]!;
      if (key === 0) continue;
      const color = colors[start]!;

      let width = 1;
      let height = 1;
      if ((key & KEY_SINGLE) === 0) {
        const widens = (key & KEY_NARROW) === 0;
        while (
          widens &&
          u + width < uSize &&
          keys[start + width] === key &&
          colors[start + width] === color
        ) {
          width += 1;
        }
        const stacks = flat || (key & KEY_STACKS) !== 0;
        while (
          stacks &&
          v + height < vSize &&
          rowMatches(keys, colors, (v + height) * uSize + u, width, key, color)
        ) {
          height += 1;
        }
      }
      for (let row = 0; row < height; row += 1) {
        keys.fill(0, (v + row) * uSize + u, (v + row) * uSize + u + width);
      }
      emit(key, color, u, v, width, height);
    }
  }
}

function rowMatches(
  keys: Uint32Array,
  colors: Uint32Array,
  start: number,
  width: number,
  key: number,
  color: number,
): boolean {
  for (let offset = 0; offset < width; offset += 1) {
    if (keys[start + offset] !== key || colors[start + offset] !== color) return false;
  }
  return true;
}

export function faceOf(face: number): Face {
  if (face < Face.PositiveX || face > Face.NegativeZ) throw new RangeError(`Invalid face ${face}`);
  return face as Face;
}

/** A volume whose covered air can be traced from the sky. */
export interface SkyVolume {
  /** Cells per side. */
  readonly size: number;
  readonly layers: number;
  /** Layer of the highest opaque cell in each column, or -1 for none. */
  readonly roof: Int16Array;
  /** Lowest layer the trace reaches in each column, from `coverFloors`. */
  readonly floor: Int16Array;
  isOpaque(index: number): boolean;
}

/** Stands in for columns without a roof while `coverFloors` looks for the lowest one. */
const NO_ROOF = 0x7fff;

/**
 * The lowest layer the sky trace reaches in each column: `depth` layers below its roof,
 * or the lowest roof within `reach` columns when that lies deeper.
 */
export function coverFloors(
  roof: Int16Array,
  size: number,
  reach: number,
  depth: number,
): Int16Array {
  // The lowest roof in a square splits into a pass along x and a pass along z.
  const rows = new Int16Array(roof.length);
  const floor = new Int16Array(roof.length);
  lowestAlong(roof, rows, size, 1, reach);
  lowestAlong(rows, floor, size, size, reach);
  for (let column = 0; column < roof.length; column += 1) {
    floor[column] = Math.min(roof[column]! - depth, floor[column]!);
  }
  return floor;
}

/** One pass of `coverFloors` along the axis whose cells lie `step` apart. */
function lowestAlong(
  source: Int16Array,
  target: Int16Array,
  size: number,
  step: number,
  reach: number,
): void {
  const lineStep = step === 1 ? size : 1;
  for (let line = 0; line < size; line += 1) {
    const start = line * lineStep;
    for (let at = 0; at < size; at += 1) {
      let lowest = NO_ROOF;
      const last = Math.min(size - 1, at + reach);
      for (let near = Math.max(0, at - reach); near <= last; near += 1) {
        const value = source[start + near * step]!;
        if (value >= 0 && value < lowest) lowest = value;
      }
      target[start + at * step] = lowest;
    }
  }
}

/**
 * Flood fills air under overhangs, eaves, canopies, and platforms from the open sky
 * beside it, down to each column's floor. Returns 1 for every reached cell.
 */
export function traceCoveredAir(volume: SkyVolume): Uint8Array {
  const { size, layers, roof, floor } = volume;
  const area = size * size;
  const reached = new Uint8Array(area * layers);
  let stack = new Int32Array(4096);
  let count = 0;
  const visit = (index: number, layer: number, column: number): void => {
    if (layer > roof[column]! || layer < floor[column]! || reached[index] === 1) return;
    if (volume.isOpaque(index)) return;
    reached[index] = 1;
    if (count === stack.length) {
      const grown = new Int32Array(stack.length * 2);
      grown.set(stack);
      stack = grown;
    }
    stack[count++] = index;
  };

  // Seed covered cells that sit beside open sky in a lower neighboring column.
  const neighbors = [1, -1, size, -size];
  for (let z = 1; z < size - 1; z += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const column = z * size + x;
      const open = roof[column]!;
      for (const step of neighbors) {
        const top = roof[column + step]!;
        for (let layer = Math.max(open + 1, floor[column + step]!); layer < top; layer += 1) {
          visit(layer * area + column + step, layer, column + step);
        }
      }
    }
  }

  while (count > 0) {
    const index = stack[--count]!;
    const layer = Math.floor(index / area);
    const column = index - layer * area;
    const x = column % size;
    const z = (column - x) / size;
    if (x > 0) visit(index - 1, layer, column - 1);
    if (x < size - 1) visit(index + 1, layer, column + 1);
    if (z > 0) visit(index - size, layer, column - size);
    if (z < size - 1) visit(index + size, layer, column + size);
    if (layer > 0) visit(index - area, layer - 1, column);
    if (layer < layers - 1) visit(index + area, layer + 1, column);
  }
  return reached;
}
