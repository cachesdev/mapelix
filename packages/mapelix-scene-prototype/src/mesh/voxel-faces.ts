import { Face, QuadMaterial, type QuadBox } from "../format.js";

/**
 * Face bookkeeping shared by the block mesher and the voxel level mesher. Both keep
 * their cells y-major in a square volume: `layer * size * size + z * size + x`.
 */

/** How far below a column's roof, in blocks, the sky trace follows open air under eaves and trees. */
export const COVER_DEPTH = 32;

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
  isOpaque(index: number): boolean;
}

/** Covered air that the sky reaches. Cells above their column's roof are open as well. */
export interface OpenAir {
  /** 1 for every reached cell. */
  readonly reached: Uint8Array;
  /** Layer of the lowest open cell in each column. */
  readonly lowest: Int16Array;
}

/**
 * Finds the covered air that a camera can see from outside. A flood fill follows air under
 * eaves, trees, and into rooms, down to `depth` layers below each column's roof. Sight
 * lines follow air that sees the sky while moving one way along x or z and upward, at any
 * depth, so the ground under platforms, bridges, and raised builds stays open.
 */
export function findOpenAir(volume: SkyVolume, depth: number): OpenAir {
  const { size, layers, roof } = volume;
  const area = size * size;
  const top = Math.min(layers - 1, highestRoof(roof));
  const opaque = new Uint8Array(area * layers);
  for (let index = 0; index < area * (top + 1); index += 1) {
    if (volume.isOpaque(index)) opaque[index] = 1;
  }
  const open: OpenAir = {
    reached: new Uint8Array(area * layers),
    lowest: roof.map((layer) => layer + 1),
  };
  floodCoveredAir(volume, opaque, depth, open);
  for (const step of [1, -1, size, -size]) traceSightLines(volume, opaque, top, step, open);
  return open;
}

function highestRoof(roof: Int16Array): number {
  let highest = -1;
  for (const layer of roof) highest = Math.max(highest, layer);
  return highest;
}

/** The lowest roof of the columns that have one. */
function lowestRoof(roof: Int16Array): number {
  let lowest = Number.POSITIVE_INFINITY;
  for (const layer of roof) if (layer >= 0) lowest = Math.min(lowest, layer);
  return lowest;
}

function markOpen(open: OpenAir, index: number, layer: number, column: number): void {
  open.reached[index] = 1;
  if (layer < open.lowest[column]!) open.lowest[column] = layer;
}

/** Flood fills covered air from the open sky beside it, down to `depth` layers below each roof. */
function floodCoveredAir(
  volume: SkyVolume,
  opaque: Uint8Array,
  depth: number,
  open: OpenAir,
): void {
  const { size, layers, roof } = volume;
  const area = size * size;
  const { reached } = open;
  let stack = new Int32Array(4096);
  let count = 0;
  const visit = (index: number, layer: number, column: number): void => {
    const columnRoof = roof[column]!;
    if (layer > columnRoof || layer < columnRoof - depth || reached[index] === 1) return;
    if (opaque[index] === 1) return;
    markOpen(open, index, layer, column);
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
      const sky = roof[column]!;
      for (const step of neighbors) {
        const columnRoof = roof[column + step]!;
        for (let layer = Math.max(sky + 1, columnRoof - depth); layer < columnRoof; layer += 1) {
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
}

/**
 * Marks covered air with a path to the sky that only moves by `step` or up. Layers run
 * from the top down, and each row from its far end, so the cell above and the next
 * cell along are always known. Columns without a roof lie outside the stored world and
 * block the lines.
 */
function traceSightLines(
  volume: SkyVolume,
  opaque: Uint8Array,
  top: number,
  step: number,
  open: OpenAir,
): void {
  const { size, roof } = volume;
  const area = size * size;
  const alongX = Math.abs(step) === 1;
  const forward = step > 0;
  const bottom = lowestRoof(roof);
  // Everything above the highest roof is open sky.
  let above = new Uint8Array(area).fill(1);
  let current = new Uint8Array(area);
  for (let layer = top; layer >= 0; layer -= 1) {
    let anyOpen = false;
    for (let row = 0; row < size; row += 1) {
      for (let visited = 0; visited < size; visited += 1) {
        const along = forward ? size - 1 - visited : visited;
        const column = alongX ? row * size + along : along * size + row;
        const index = layer * area + column;
        const columnRoof = roof[column]!;
        let isOpen = 0;
        if (opaque[index] === 0 && columnRoof >= 0) {
          if (layer > columnRoof) {
            isOpen = 1;
          } else {
            const hasNext = forward ? along < size - 1 : along > 0;
            isOpen = above[column]! | (hasNext ? current[column + step]! : 0);
            if (isOpen === 1) markOpen(open, index, layer, column);
          }
        }
        current[column] = isOpen;
        anyOpen ||= isOpen === 1;
      }
    }
    // Below every roof, open cells only come from open cells above them.
    if (!anyOpen && layer <= bottom) return;
    [above, current] = [current, above];
  }
}
