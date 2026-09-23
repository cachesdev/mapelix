import {
  EMPTY_HEIGHT,
  Face,
  QuadList,
  QuadMaterial,
  SOIL_COLOR,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  type SceneRegion,
} from "../format.js";
import { VoxelKind } from "./block-palette.js";
import {
  COVER_DEPTH,
  COVER_REACH,
  KEY_COVERED,
  NORMAL_LAYER,
  cornerOcclusion,
  faceOf,
  faceSteps,
  isFlatFace,
  keyBox,
  keyMaterial,
  coverFloors,
  maskOffset,
  maskSlice,
  mergeKey,
  mergeSlice,
  slicePosition,
  sliceLayout,
  traceCoveredAir,
  type FaceSteps,
} from "./voxel-faces.js";
import { isOpaqueKind, type VoxelBox } from "./voxel-box.js";
import type { VoxelRegion } from "./voxel-region.js";

/**
 * Border faces stay when a neighbor hides them this many layers below its top. A
 * neighbor drawn at another level can sit lower, and these skirts close the gap.
 */
const SKIRT_LAYERS = 2;
/**
 * Walls facing unexplored land reach this many blocks below a column's highest block,
 * under any water, like the cut edge of a diorama.
 */
const EDGE_DEPTH = 16;

const MATERIALS: Readonly<Record<number, QuadMaterial>> = {
  [VoxelKind.Solid]: QuadMaterial.Solid,
  [VoxelKind.Foliage]: QuadMaterial.Foliage,
  [VoxelKind.Emissive]: QuadMaterial.Emissive,
  [VoxelKind.Water]: QuadMaterial.Water,
  [VoxelKind.Glass]: QuadMaterial.Glass,
};

/**
 * Turns a voxel region into packed quads, in voxel units. Like level 0, it keeps only
 * faces that touch air the sky can reach, merges equal faces, and shades corners.
 */
export function meshVoxelRegion(region: VoxelRegion): SceneRegion {
  return new VoxelLevelMesher(region).mesh();
}

class VoxelLevelMesher {
  private readonly region: VoxelRegion;
  private readonly box: VoxelBox;
  private readonly steps: FaceSteps;
  private readonly area: number;
  /** Layer of the highest opaque voxel in each box column, or -1. */
  private readonly roof: Int16Array;
  /** Layer of the highest voxel of any kind in each box column, or -1. */
  private readonly top: Int16Array;
  /** Lowest open layer of each box column. */
  private readonly floor: Int16Array;
  private readonly reached: Uint8Array;
  /** Lowest layer per region column that can own a visible face. */
  private readonly columnLow: Int16Array;
  /** Layers of wall below a column's highest block where it faces unexplored land. */
  private readonly edgeLayers: number;
  private readonly opaque = new QuadList();
  private readonly translucent = new QuadList();
  /** World y of layer 0, in voxels. */
  private readonly baseLayer: number;
  private low = Number.POSITIVE_INFINITY;
  private high = -1;
  private minLayer = Number.POSITIVE_INFINITY;
  private maxLayer = Number.NEGATIVE_INFINITY;

  constructor(region: VoxelRegion) {
    this.region = region;
    this.box = region.box;
    this.steps = faceSteps(region.box.width);
    this.area = region.box.width ** 2;
    this.baseLayer = region.low / region.voxelSize;
    this.edgeLayers = Math.max(1, EDGE_DEPTH / region.voxelSize);
    this.roof = new Int16Array(this.area).fill(-1);
    this.top = new Int16Array(this.area).fill(-1);
    this.findColumnTops();
    const { voxelSize } = region;
    this.floor = coverFloors(
      this.roof,
      this.box.width,
      Math.ceil(COVER_REACH / voxelSize),
      Math.ceil(COVER_DEPTH / voxelSize),
    );
    this.reached = traceCoveredAir({
      size: this.box.width,
      layers: this.box.layers,
      roof: this.roof,
      floor: this.floor,
      isOpaque: (index) => isOpaqueKind(this.box.kind[index]!),
    });
    this.columnLow = this.findColumnRanges();
  }

  mesh(): SceneRegion {
    if (this.high >= this.low) {
      for (let face = 0; face < 6; face += 1) this.meshFace(face);
    }
    const { voxelSize } = this.region;
    const empty = new Uint32Array(0);
    return {
      level: this.region.level,
      x: this.region.x,
      z: this.region.z,
      heights: this.heights(),
      minY: Number.isFinite(this.minLayer) ? this.minLayer * voxelSize : 0,
      maxY: Number.isFinite(this.maxLayer) ? this.maxLayer * voxelSize : 0,
      opaque: this.opaque.finish(),
      plants: empty,
      translucent: this.translucent.finish(),
    };
  }

  private findColumnTops(): void {
    const { box, area } = this;
    for (let column = 0; column < area; column += 1) {
      for (let layer = box.layers - 1; layer >= 0; layer -= 1) {
        const kind = box.kind[layer * area + column]!;
        if (kind === VoxelKind.Air) continue;
        if (this.top[column] === -1) this.top[column] = layer;
        if (isOpaqueKind(kind)) {
          this.roof[column] = layer;
          break;
        }
      }
    }
  }

  /** As at level 0, open voxels lie at or above the floor of their column. */
  private findColumnRanges(): Int16Array {
    const { span, margin } = this.region;
    const width = this.box.width;
    const columnLow = new Int16Array(span * span);
    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const column = (z + margin) * width + x + margin;
        const top = this.top[column]!;
        let low = this.edgeFloor(column);
        for (const neighbor of [column, column + 1, column - 1, column + width, column - width]) {
          if (this.region.explored[neighbor] === 1) {
            low = Math.min(low, this.floor[neighbor]! - 1);
          }
        }
        low = Math.max(0, low);
        columnLow[z * span + x] = low;
        if (top === -1) continue;
        this.low = Math.min(this.low, low);
        this.high = Math.max(this.high, top);
      }
    }
    return columnLow;
  }

  private meshFace(face: number): void {
    const { span, margin } = this.region;
    const width = this.box.width;
    const layout = sliceLayout(face, span, this.high - this.low + 1);
    const keys = new Uint32Array(layout.slices * layout.area);
    const colors = new Uint32Array(layout.slices * layout.area);
    const used = new Uint8Array(layout.slices);

    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const column = (z + margin) * width + x + margin;
        const border = isBorderFace(face, x, z, span);
        const top = this.top[column]!;
        for (let layer = this.columnLow[z * span + x]!; layer <= top; layer += 1) {
          const slice = maskSlice(face, x, layer - this.low, z);
          const mask = slice * layout.area + maskOffset(face, span, x, layer - this.low, z);
          const index = layer * this.area + column;
          if (this.writeFace(face, index, layer, column, border, keys, colors, mask)) {
            used[slice] = 1;
          }
        }
      }
    }

    for (let slice = 0; slice < layout.slices; slice += 1) {
      if (used[slice] === 0) continue;
      const start = slice * layout.area;
      mergeSlice(
        face,
        keys.subarray(start, start + layout.area),
        colors.subarray(start, start + layout.area),
        layout,
        (key, color, u, v, width, height) => {
          this.emit(key, color, face, slice, u, v, width, height);
        },
      );
    }
  }

  /**
   * Writes the merge key and packed color of one face into a slice mask.
   * Returns false, and writes nothing, when the face is hidden.
   */
  private writeFace(
    face: number,
    index: number,
    layer: number,
    column: number,
    border: boolean,
    keys: Uint32Array,
    colors: Uint32Array,
    mask: number,
  ): boolean {
    const { box } = this;
    const kind = box.kind[index]!;
    if (kind === VoxelKind.Air) return false;
    const fill = box.fill[index]!;
    // A water surface below the top of its voxel shows when the sky reaches the voxel,
    // unless a block sits right on it.
    const inner = face === Face.PositiveY && fill < 16;
    const neighbor = index + this.steps.normal[face]!;
    const neighborLayer = layer + NORMAL_LAYER[face]!;
    const neighborColumn = column + this.steps.column[face]!;
    if (inner) {
      if (isOpaqueKind(box.kind[neighbor] ?? VoxelKind.Air) || !this.isOpen(index, layer, column)) {
        return false;
      }
    } else if (!this.region.explored[neighborColumn]) {
      if (layer < this.edgeFloor(column)) return false;
    } else if (!this.showsFace(kind, neighbor, neighborLayer, neighborColumn, border)) {
      return false;
    }

    const occlusion = inner
      ? this.occlusion(face, index, layer)
      : this.occlusion(face, neighbor, neighborLayer);
    const covered = box.covered[index] === 1 && !isFlatFace(face);
    const key = mergeKey(MATERIALS[kind]!, fill, 0, false, face);
    keys[mask] = covered ? (key | KEY_COVERED) >>> 0 : key;
    colors[mask] = packQuadWord2(this.faceColor(index, face), occlusion);
    return true;
  }

  /** Whether a face of a `kind` voxel shows against the voxel in front of it. */
  private showsFace(
    kind: number,
    neighbor: number,
    neighborLayer: number,
    neighborColumn: number,
    border: boolean,
  ): boolean {
    // Below the box is buried rock; above it is open sky.
    if (neighborLayer < 0) return false;
    if (neighborLayer >= this.box.layers) return true;
    const neighborKind = this.box.kind[neighbor]!;
    if (isOpaqueKind(neighborKind)) {
      return (
        border && isOpaqueKind(kind) && neighborLayer > this.roof[neighborColumn]! - SKIRT_LAYERS
      );
    }
    if (neighborKind !== VoxelKind.Air && neighborKind === kind) return false;
    return this.isOpen(neighbor, neighborLayer, neighborColumn);
  }

  private faceColor(index: number, face: number): number {
    if (face === Face.PositiveY) return this.box.top[index]!;
    if (face === Face.NegativeY && this.box.covered[index] === 1) return SOIL_COLOR;
    return this.box.side[index]!;
  }

  private emit(
    key: number,
    color: number,
    face: number,
    slice: number,
    u: number,
    v: number,
    width: number,
    height: number,
  ): void {
    const [x, layer, z] = slicePosition(face, slice, u, v, this.low);
    const material = keyMaterial(key);
    const y = this.baseLayer + layer;
    const translucent = material === QuadMaterial.Water || material === QuadMaterial.Glass;
    (translucent ? this.translucent : this.opaque).push(
      packQuadWord0(x, y, z, faceOf(face), material, (key & KEY_COVERED) !== 0),
      packQuadWord1(width, height, keyBox(key), 0),
      color,
    );
    this.minLayer = Math.min(this.minLayer, y);
    this.maxLayer = Math.max(this.maxLayer, y + (isFlatFace(face) ? 1 : height));
  }

  /** Top of the highest voxel in each region column, in blocks. */
  private heights(): Int16Array {
    const { span, margin, voxelSize } = this.region;
    const width = this.box.width;
    const heights = new Int16Array(span * span);
    for (let z = 0; z < span; z += 1) {
      for (let x = 0; x < span; x += 1) {
        const top = this.top[(z + margin) * width + x + margin]!;
        heights[z * span + x] = top === -1 ? EMPTY_HEIGHT : (this.baseLayer + top + 1) * voxelSize;
      }
    }
    return heights;
  }

  private occlusion(face: number, front: number, frontLayer: number): number {
    return cornerOcclusion(
      this.steps,
      face,
      front,
      frontLayer,
      (index, layer) =>
        layer >= 0 && layer < this.box.layers && isOpaqueKind(this.box.kind[index]!),
    );
  }

  /** Lowest layer of the walls facing unexplored land. Over water, the walls reach below the floor. */
  private edgeFloor(column: number): number {
    const roof = this.roof[column]!;
    return (roof === -1 ? this.top[column]! : roof) - this.edgeLayers;
  }

  /** A voxel is open when the sky reaches it directly or through covered air. */
  private isOpen(index: number, layer: number, column: number): boolean {
    return layer > this.roof[column]! || this.reached[index] === 1;
  }
}

/** Faces that point out of the region, onto a neighbor that may be drawn at another level. */
function isBorderFace(face: number, x: number, z: number, span: number): boolean {
  switch (face) {
    case Face.PositiveX:
      return x === span - 1;
    case Face.NegativeX:
      return x === 0;
    case Face.PositiveZ:
      return z === span - 1;
    case Face.NegativeZ:
      return z === 0;
    default:
      return false;
  }
}
