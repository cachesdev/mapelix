import { SOIL_COLOR } from "../format.js";
import { VoxelKind } from "./block-palette.js";

/**
 * A square box of voxels, stored y-major: `(layer * width + z) * width + x`. Chunks
 * and voxel regions both use it, at every voxel size.
 */
export class VoxelBox {
  readonly width: number;
  readonly layers: number;
  /** `VoxelKind` of each voxel. */
  readonly kind: Uint8Array;
  /** Packed sRGB color of the top face. */
  readonly top: Uint32Array;
  /** Packed sRGB color of the side faces. Covered sides hold the color of their strip. */
  readonly side: Uint32Array;
  /** Height of the voxel's contents in sixteenths. Only water surfaces sit lower than 16. */
  readonly fill: Uint8Array;
  /** 1 where the sides are soil under a strip of the side color, like a grass block's. */
  readonly covered: Uint8Array;
  /** Layers from the bottom that may hold voxels. Everything above them is air. */
  filled: number;

  constructor(width: number, layers: number) {
    const count = width * width * layers;
    this.width = width;
    this.layers = layers;
    this.kind = new Uint8Array(count);
    this.top = new Uint32Array(count);
    this.side = new Uint32Array(count);
    this.fill = new Uint8Array(count);
    this.covered = new Uint8Array(count);
    this.filled = layers;
  }

  index(x: number, layer: number, z: number): number {
    return (layer * this.width + z) * this.width + x;
  }

  /** Empties the box for reuse. */
  clear(): void {
    this.kind.fill(0);
    this.top.fill(0);
    this.side.fill(0);
    this.fill.fill(0);
    this.covered.fill(0);
    this.filled = this.layers;
  }

  /** Copies voxel `from` of `source` into voxel `to`. */
  copy(source: VoxelBox, from: number, to: number): void {
    this.kind[to] = source.kind[from]!;
    this.top[to] = source.top[from]!;
    this.side[to] = source.side[from]!;
    this.fill[to] = source.fill[from]!;
    this.covered[to] = source.covered[from]!;
  }
}

/** Solid, foliage, and emissive voxels hide what is behind them. */
export function isOpaqueKind(kind: number): boolean {
  return kind === VoxelKind.Solid || kind === VoxelKind.Foliage || kind === VoxelKind.Emissive;
}

/** What a parent voxel becomes. Opaque parents then pick their kind by majority. */
const Group = { Air: 0, Opaque: 1, Water: 2, Glass: 3 } as const;
type Group = (typeof Group)[keyof typeof Group];

function inGroup(kind: number, group: Group): boolean {
  if (group === Group.Opaque) return isOpaqueKind(kind);
  return kind === (group === Group.Water ? VoxelKind.Water : VoxelKind.Glass);
}

/** Child indexes of one parent: the lower four, then the upper four, each in (x, z) order. */
const children = new Int32Array(8);

/**
 * Merges every 2×2×2 group of voxels into one, as Voxy builds its coarser levels, so
 * the box halves along each axis. `source.layers` must be even, and `target`, when
 * given, must be an empty box of the halved size.
 */
export function halveVoxels(
  source: VoxelBox,
  target = new VoxelBox(source.width / 2, source.layers / 2),
): VoxelBox {
  const width = target.width;
  const row = source.width;
  const area = row * row;
  target.filled = Math.ceil(source.filled / 2);
  for (let layer = 0; layer < target.filled; layer += 1) {
    for (let z = 0; z < width; z += 1) {
      for (let x = 0; x < width; x += 1) {
        const first = (layer * 2 * row + z * 2) * row + x * 2;
        children[0] = first;
        children[1] = first + 1;
        children[2] = first + row;
        children[3] = first + row + 1;
        for (let child = 0; child < 4; child += 1) children[child + 4] = children[child]! + area;
        mergeChildren(source, target, target.index(x, layer, z));
      }
    }
  }
  return target;
}

function mergeChildren(source: VoxelBox, target: VoxelBox, parent: number): void {
  // Open sky and deep rock are the common cases: eight equal voxels merge into a copy.
  if (allEqual(source)) {
    if (source.kind[children[0]!] !== VoxelKind.Air) target.copy(source, children[0]!, parent);
    return;
  }
  const { kind, top, side, covered } = source;
  const group = allOpaque(kind) ? Group.Opaque : chooseGroup(kind);
  if (group === Group.Air) return;

  // The top shows the highest child of the group in each of the four sub-columns.
  let red = 0;
  let green = 0;
  let blue = 0;
  let tops = 0;
  let soil = 0;
  for (let column = 0; column < 4; column += 1) {
    const upper = children[column + 4]!;
    const child = inGroup(kind[upper]!, group) ? upper : children[column]!;
    if (!inGroup(kind[child]!, group)) continue;
    const color = top[child]!;
    red += (color >> 16) & 0xff;
    green += (color >> 8) & 0xff;
    blue += color & 0xff;
    soil += covered[child]!;
    tops += 1;
  }
  const topColor = averageColor(red, green, blue, tops);

  red = 0;
  green = 0;
  blue = 0;
  let sides = 0;
  for (let index = 0; index < 8; index += 1) {
    const child = children[index]!;
    if (!inGroup(kind[child]!, group)) continue;
    const color = covered[child] === 1 ? SOIL_COLOR : side[child]!;
    red += (color >> 16) & 0xff;
    green += (color >> 8) & 0xff;
    blue += color & 0xff;
    sides += 1;
  }
  const isCovered = soil * 2 > tops;

  target.kind[parent] = group === Group.Opaque ? opaqueKind(kind) : groupKind(group);
  target.top[parent] = topColor;
  // A covered side draws soil itself and keeps only the color of its strip.
  target.side[parent] = isCovered ? topColor : averageColor(red, green, blue, sides);
  target.covered[parent] = isCovered ? 1 : 0;
  target.fill[parent] = group === Group.Water ? waterFill(source) : 16;
}

function allOpaque(kind: Uint8Array): boolean {
  for (let index = 0; index < 8; index += 1) {
    if (!isOpaqueKind(kind[children[index]!]!)) return false;
  }
  return true;
}

function allEqual(source: VoxelBox): boolean {
  const { kind, top, side, fill, covered } = source;
  const first = children[0]!;
  for (let index = 1; index < 8; index += 1) {
    const child = children[index]!;
    if (kind[child] !== kind[first]) return false;
    if (kind[first] === VoxelKind.Air) continue;
    if (
      top[child] !== top[first] ||
      side[child] !== side[first] ||
      fill[child] !== fill[first] ||
      covered[child] !== covered[first]
    ) {
      return false;
    }
  }
  return true;
}

function averageColor(red: number, green: number, blue: number, count: number): number {
  const samples = Math.max(1, count);
  return (
    (Math.round(red / samples) << 16) |
    (Math.round(green / samples) << 8) |
    Math.round(blue / samples)
  );
}

/**
 * Picks what a parent shows. The upper half decides first, so thin floors, roofs, and
 * the sea surface survive; within a half, blocks win ties against water. Air never
 * wins against anything visible, which keeps walls and towers standing far away.
 */
function chooseGroup(kind: Uint8Array): Group {
  const upper = halfGroup(kind, 4);
  if (upper !== Group.Air) return upper;
  const lower = halfGroup(kind, 0);
  if (lower !== Group.Air) return lower;
  for (let index = 0; index < 8; index += 1) {
    if (kind[children[index]!] === VoxelKind.Glass) return Group.Glass;
  }
  return Group.Air;
}

/** The group four children at `start` decide on, or air when they hold no blocks or water. */
function halfGroup(kind: Uint8Array, start: number): Group {
  let opaque = 0;
  let water = 0;
  for (let index = start; index < start + 4; index += 1) {
    const childKind = kind[children[index]!]!;
    if (isOpaqueKind(childKind)) opaque += 1;
    else if (childKind === VoxelKind.Water) water += 1;
  }
  if (opaque + water === 0) return Group.Air;
  return opaque >= water ? Group.Opaque : Group.Water;
}

function groupKind(group: Group): number {
  return group === Group.Water ? VoxelKind.Water : VoxelKind.Glass;
}

/**
 * The most common opaque kind. Lights count twice, so lanterns and glowstone keep
 * glowing a little farther out; ties go to solid blocks, then foliage.
 */
function opaqueKind(kind: Uint8Array): number {
  let solid = 0;
  let foliage = 0;
  let emissive = 0;
  for (let index = 0; index < 8; index += 1) {
    const childKind = kind[children[index]!];
    if (childKind === VoxelKind.Solid) solid += 1;
    else if (childKind === VoxelKind.Foliage) foliage += 1;
    else if (childKind === VoxelKind.Emissive) emissive += 2;
  }
  if (solid >= foliage && solid >= emissive) return VoxelKind.Solid;
  return foliage >= emissive ? VoxelKind.Foliage : VoxelKind.Emissive;
}

/** Keeps the water surface at its height within the parent, in sixteenths. */
function waterFill(source: VoxelBox): number {
  let upper = 0;
  let lower = 0;
  for (let index = 0; index < 8; index += 1) {
    const child = children[index]!;
    if (source.kind[child] !== VoxelKind.Water) continue;
    if (index >= 4) upper = Math.max(upper, source.fill[child]!);
    else lower = Math.max(lower, source.fill[child]!);
  }
  return upper > 0 ? Math.round((16 + upper) / 2) : Math.max(1, Math.round(lower / 2));
}
