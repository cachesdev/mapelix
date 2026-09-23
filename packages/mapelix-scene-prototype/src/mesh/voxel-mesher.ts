import {
  BASE_REGION_SPAN,
  EMPTY_HEIGHT,
  Face,
  FULLY_LIT,
  QuadList,
  QuadMaterial,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  type PlantSprite,
  type SceneRegion,
} from "../format.js";
import { blendColumnTints } from "./biome-tints.js";
import { BlockPalette, PALETTE_ID_MASK, Shape, TintCode, WATERLOGGED } from "./block-palette.js";
import {
  NO_BLOCK,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  type RegionVolume,
} from "./region-volume.js";

/** How far below a column's roof the sky trace follows open air, such as under eaves and trees. */
const COVER_DEPTH = 32;
const TINT_RADIUS = 2;
const SPAN = BASE_REGION_SPAN;

// Cell index steps along each face's normal and tangents, in `Face` order. Faces on the
// x and z axes use (z, y) and (x, y) as tangents; top and bottom faces use (x, z).
const NORMAL_STEP = [1, -1, VOLUME_LAYER, -VOLUME_LAYER, VOLUME_SIZE, -VOLUME_SIZE];
const NORMAL_Y = [0, 0, 1, -1, 0, 0];
const COLUMN_STEP = [1, -1, 0, 0, VOLUME_SIZE, -VOLUME_SIZE];
const TANGENT_U_STEP = [VOLUME_SIZE, VOLUME_SIZE, 1, 1, 1, 1];
const TANGENT_V_STEP = [
  VOLUME_LAYER,
  VOLUME_LAYER,
  VOLUME_SIZE,
  VOLUME_SIZE,
  VOLUME_LAYER,
  VOLUME_LAYER,
];
const NEIGHBOR_COLUMNS = [1, -1, VOLUME_SIZE, -VOLUME_SIZE];
/** Occlusion corners in quad order: (0, 0), (1, 0), (1, 1), (0, 1) along the tangents. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

const KEY_PRESENT = 1 << 31;
const KEY_SINGLE = 1 << 30;
const KEY_STACKS = 1 << 29;
const KEY_NARROW = 1 << 28;
const WATER_SURFACE_SIZE = 14;

/**
 * Turns a level 0 volume into packed quads. Only faces that touch air reachable
 * from the sky are kept, so cave walls and sealed interiors cost nothing.
 */
export function meshRegionVolume(
  volume: RegionVolume,
  palette: BlockPalette,
  regionX: number,
  regionZ: number,
): SceneRegion {
  return new VoxelMesher(volume, palette).mesh(regionX, regionZ);
}

class VoxelMesher {
  private readonly volume: RegionVolume;
  private readonly palette: BlockPalette;
  private readonly cells: Uint16Array;
  /** Covered air cells that connect to the sky. Open air above `topSolid` is implied. */
  private readonly reached: Uint8Array;
  private readonly tints: Uint32Array[];
  private readonly opaque = new QuadList();
  private readonly plants = new QuadList();
  private readonly translucent = new QuadList();
  /** Lowest block per region column that can own a visible face. */
  private readonly columnLow = new Int16Array(SPAN * SPAN);
  private low = WORLD_MAX_Y;
  private high = NO_BLOCK;
  private minY = WORLD_MAX_Y;
  private maxY = WORLD_MIN_Y;

  constructor(volume: RegionVolume, palette: BlockPalette) {
    this.volume = volume;
    this.palette = palette;
    this.cells = volume.cells;
    this.reached = new Uint8Array(volume.cells.length);
    this.tints = blendColumnTints(
      { biomes: volume.biomes, stride: VOLUME_SIZE },
      VOLUME_MARGIN,
      SPAN,
      TINT_RADIUS,
    );
  }

  mesh(regionX: number, regionZ: number): SceneRegion {
    this.traceCoveredAir();
    this.findColumnRanges();
    if (this.high >= this.low) {
      for (let face = 0; face < 6; face += 1) this.meshFace(face);
      this.meshPlants();
    }
    return {
      level: 0,
      x: regionX,
      z: regionZ,
      heights: this.heights(),
      minY: Math.min(this.minY, this.maxY),
      maxY: this.maxY,
      opaque: this.opaque.finish(),
      plants: this.plants.finish(),
      translucent: this.translucent.finish(),
    };
  }

  /** Flood fills air under overhangs, eaves, and canopies from the open sky beside it. */
  private traceCoveredAir(): void {
    const { topSolid } = this.volume;
    let stack = new Int32Array(4096);
    let size = 0;
    const visit = (index: number, y: number, column: number): void => {
      const roof = topSolid[column]!;
      if (y > roof || y < roof - COVER_DEPTH || this.reached[index] === 1) return;
      if (this.isOpaque(index)) return;
      this.reached[index] = 1;
      if (size === stack.length) {
        const grown = new Int32Array(stack.length * 2);
        grown.set(stack);
        stack = grown;
      }
      stack[size++] = index;
    };

    // Seed covered cells that sit beside open sky in a lower neighboring column.
    for (let z = 1; z < VOLUME_SIZE - 1; z += 1) {
      for (let x = 1; x < VOLUME_SIZE - 1; x += 1) {
        const column = z * VOLUME_SIZE + x;
        const open = topSolid[column]!;
        for (const step of NEIGHBOR_COLUMNS) {
          const roof = topSolid[column + step]!;
          for (let y = Math.max(open + 1, roof - COVER_DEPTH); y < roof; y += 1) {
            visit(cellIndex(x, y, z) + step, y, column + step);
          }
        }
      }
    }

    while (size > 0) {
      const index = stack[--size]!;
      const y = Math.floor(index / VOLUME_LAYER) + WORLD_MIN_Y;
      const column = index % VOLUME_LAYER;
      const x = column % VOLUME_SIZE;
      const z = Math.floor(column / VOLUME_SIZE);
      if (x > 0) visit(index - 1, y, column - 1);
      if (x < VOLUME_SIZE - 1) visit(index + 1, y, column + 1);
      if (z > 0) visit(index - VOLUME_SIZE, y, column - VOLUME_SIZE);
      if (z < VOLUME_SIZE - 1) visit(index + VOLUME_SIZE, y, column + VOLUME_SIZE);
      if (y > WORLD_MIN_Y) visit(index - VOLUME_LAYER, y - 1, column);
      if (y < WORLD_MAX_Y - 1) visit(index + VOLUME_LAYER, y + 1, column);
    }
  }

  /**
   * A block can only own a visible face if an open cell touches it, and open cells lie
   * at most `COVER_DEPTH` below their column's roof. The lowest roof around a column
   * therefore bounds the blocks worth testing there.
   */
  private findColumnRanges(): void {
    const { topSolid, topBlock } = this.volume;
    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        let roof = topSolid[column]!;
        for (const step of NEIGHBOR_COLUMNS) roof = Math.min(roof, topSolid[column + step]!);
        const low = Math.max(WORLD_MIN_Y, roof - COVER_DEPTH - 1);
        this.columnLow[z * SPAN + x] = low;
        const top = topBlock[column]!;
        if (top === NO_BLOCK) continue;
        this.low = Math.min(this.low, low);
        this.high = Math.max(this.high, top);
      }
    }
  }

  /** Builds one face direction into per-slice masks, then merges equal faces into rectangles. */
  private meshFace(face: number): void {
    const layout = sliceLayout(face, this.high - this.low + 1);
    const keys = new Uint32Array(layout.slices * layout.area);
    const colors = new Uint32Array(layout.slices * layout.area);
    const used = new Uint8Array(layout.slices);

    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        const top = this.volume.topBlock[column]!;
        for (let y = this.columnLow[z * SPAN + x]!; y <= top; y += 1) {
          const slice = maskSlice(face, x, y - this.low, z);
          const mask = slice * layout.area + maskOffset(face, x, y - this.low, z);
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN);
          if (this.writeFace(face, index, y, column, keys, colors, mask)) used[slice] = 1;
        }
      }
    }

    for (let slice = 0; slice < layout.slices; slice += 1) {
      if (used[slice] === 0) continue;
      const start = slice * layout.area;
      this.mergeSlice(
        face,
        slice,
        keys.subarray(start, start + layout.area),
        colors.subarray(start, start + layout.area),
        layout,
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
    y: number,
    column: number,
    keys: Uint32Array,
    colors: Uint32Array,
    mask: number,
  ): boolean {
    const cell = this.cells[index]!;
    const id = cell & PALETTE_ID_MASK;
    const shape = this.palette.shape[id]!;
    // Waterlogged plants and gaps render as water. Waterlogged stairs and slabs keep their shape.
    const passable = shape === Shape.Empty || shape === Shape.Plant;
    if (shape === Shape.Water || (passable && (cell & WATERLOGGED) !== 0)) {
      return this.writeWaterFace(face, index, y, column, keys, colors, mask);
    }
    if (passable) return false;

    const size = this.palette.boxSize[id]!;
    const inset = this.palette.boxInset[id]!;
    const anchoredTop = this.palette.boxTop[id] === 1;
    const boundary = isBoundaryFace(face, size, inset, anchoredTop);
    const neighbor = index + NORMAL_STEP[face]!;
    const neighborY = y + NORMAL_Y[face]!;
    const neighborColumn = column + COLUMN_STEP[face]!;
    if (boundary) {
      if (neighborY < WORLD_MIN_Y) return false;
      if (neighborY < WORLD_MAX_Y) {
        if (this.hides(this.cells[neighbor]!, face, id)) return false;
        if (!this.isOpen(neighbor, neighborY, neighborColumn)) return false;
      }
    } else if (!this.isOpen(index, y, column)) {
      return false;
    }

    const occlusion = boundary
      ? this.occlusion(face, neighbor, neighborY)
      : this.occlusion(face, index, y);
    keys[mask] = mergeKey(this.palette.material[id]!, size, inset, anchoredTop, face);
    colors[mask] = packQuadWord2(this.colorOf(id, face, column), occlusion);
    return true;
  }

  /** Water surfaces sit two sixteenths below the block top, like Minecraft's still water. */
  private writeWaterFace(
    face: number,
    index: number,
    y: number,
    column: number,
    keys: Uint32Array,
    colors: Uint32Array,
    mask: number,
  ): boolean {
    const surface = y + 1 >= WORLD_MAX_Y || !this.isWater(this.cells[index + VOLUME_LAYER]!);
    const size = surface ? WATER_SURFACE_SIZE : 16;
    if (face === Face.PositiveY && surface) {
      if (!this.isOpen(index, y, column)) return false;
    } else {
      const neighborY = y + NORMAL_Y[face]!;
      if (neighborY < WORLD_MIN_Y) return false;
      if (neighborY < WORLD_MAX_Y) {
        const neighbor = index + NORMAL_STEP[face]!;
        const neighborCell = this.cells[neighbor]!;
        const neighborShape = this.palette.shape[neighborCell & PALETTE_ID_MASK]!;
        if (this.isWater(neighborCell) || neighborShape === Shape.Cube) return false;
        if (neighborShape === Shape.Glass) return false;
        if (!this.isOpen(neighbor, neighborY, column + COLUMN_STEP[face]!)) return false;
      }
    }
    keys[mask] = mergeKey(QuadMaterial.Water, size, 0, false, face);
    colors[mask] = packQuadWord2(this.tintOf(TintCode.Water, column), FULLY_LIT);
    return true;
  }

  private mergeSlice(
    face: number,
    slice: number,
    keys: Uint32Array,
    colors: Uint32Array,
    layout: SliceLayout,
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
        this.emit(key, color, face, slice, u, v, width, height);
      }
    }
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
    const [x, y, z] = slicePosition(face, slice, u, v, this.low);
    const material = keyMaterial(key);
    const box = {
      size: (key & 0xf) + 1,
      inset: (key >>> 4) & 0x7,
      anchoredTop: ((key >>> 7) & 1) === 1,
    };
    const translucent = material === QuadMaterial.Water || material === QuadMaterial.Glass;
    (translucent ? this.translucent : this.opaque).push(
      packQuadWord0(x, y, z, faceOf(face), material),
      packQuadWord1(width, height, box, 0),
      color,
    );
    this.minY = Math.min(this.minY, y);
    this.maxY = Math.max(this.maxY, y + (isFlatFace(face) ? 1 : height));
  }

  /** Crossed planes for grass, flowers, crops, and saplings that the sky can see. */
  private meshPlants(): void {
    const { palette } = this;
    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        const top = this.volume.topBlock[column]!;
        for (let y = this.columnLow[z * SPAN + x]!; y <= top; y += 1) {
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN);
          const id = this.cells[index]! & PALETTE_ID_MASK;
          if (palette.shape[id] !== Shape.Plant || !this.isOpen(index, y, column)) continue;
          const box = {
            size: palette.boxSize[id]!,
            inset: palette.boxInset[id]!,
            anchoredTop: false,
          };
          const word1 = packQuadWord1(1, 1, box, spriteOf(palette.sprite[id]!));
          const word2 = packQuadWord2(this.colorOf(id, Face.PositiveY, column), FULLY_LIT);
          this.plants.push(packQuadWord0(x, y, z, Face.CrossA, QuadMaterial.Plant), word1, word2);
          this.plants.push(packQuadWord0(x, y, z, Face.CrossB, QuadMaterial.Plant), word1, word2);
        }
      }
    }
  }

  private heights(): Int16Array {
    const heights = new Int16Array(SPAN * SPAN);
    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const top = this.volume.topBlock[(z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN]!;
        heights[z * SPAN + x] = top === NO_BLOCK ? EMPTY_HEIGHT : top + 1;
      }
    }
    return heights;
  }

  /** Four corner occlusion levels from the opaque cubes around the cell in front of a face. */
  private occlusion(face: number, front: number, frontY: number): number {
    const uStep = TANGENT_U_STEP[face]!;
    const vStep = TANGENT_V_STEP[face]!;
    const vIsY = !isFlatFace(face);
    let packed = 0;
    for (let corner = 0; corner < 4; corner += 1) {
      const [su, sv] = CORNERS[corner]!;
      const sideY = vIsY ? frontY + sv : frontY;
      const side1 = this.isSolidAt(front + su * uStep, frontY);
      const side2 = this.isSolidAt(front + sv * vStep, sideY);
      const diagonal = this.isSolidAt(front + su * uStep + sv * vStep, sideY);
      const level = side1 && side2 ? 0 : 3 - Number(side1) - Number(side2) - Number(diagonal);
      packed |= level << (corner * 2);
    }
    return packed;
  }

  /** True when a neighbor cell completely covers the shared face of block `id`. */
  private hides(neighbor: number, face: number, id: number): boolean {
    const neighborId = neighbor & PALETTE_ID_MASK;
    const shape = this.palette.shape[neighborId]!;
    if (shape === Shape.Cube) return true;
    if (shape === Shape.Glass) return neighborId === id;
    if (shape !== Shape.Box || this.palette.boxInset[neighborId] !== 0) return false;
    const size = this.palette.boxSize[neighborId]!;
    const top = this.palette.boxTop[neighborId] === 1;
    if (face === Face.PositiveY) return !top || size === 16;
    if (face === Face.NegativeY) return top || size === 16;
    return size === 16;
  }

  /** A cell is open when the sky reaches it directly or through covered air. */
  private isOpen(index: number, y: number, column: number): boolean {
    return y > this.volume.topSolid[column]! || this.reached[index] === 1;
  }

  private isSolidAt(index: number, y: number): boolean {
    return y >= WORLD_MIN_Y && y < WORLD_MAX_Y && this.isOpaque(index);
  }

  private isOpaque(index: number): boolean {
    return this.palette.shape[this.cells[index]! & PALETTE_ID_MASK] === Shape.Cube;
  }

  private isWater(cell: number): boolean {
    return (cell & WATERLOGGED) !== 0 || this.palette.shape[cell & PALETTE_ID_MASK] === Shape.Water;
  }

  private colorOf(id: number, face: number, column: number): number {
    const tint = this.palette.tints[id * 6 + face]!;
    return tint === TintCode.None ? this.palette.colors[id * 6 + face]! : this.tintOf(tint, column);
  }

  private tintOf(tint: number, column: number): number {
    const x = (column % VOLUME_SIZE) - VOLUME_MARGIN;
    const z = Math.floor(column / VOLUME_SIZE) - VOLUME_MARGIN;
    return this.tints[tint]![z * SPAN + x]!;
  }
}

/** Mask dimensions for one face direction. Flat faces slice along y; the others along x or z. */
interface SliceLayout {
  readonly slices: number;
  readonly uSize: number;
  readonly vSize: number;
  readonly area: number;
}

function sliceLayout(face: number, height: number): SliceLayout {
  const flat = isFlatFace(face);
  const vSize = flat ? SPAN : height;
  return { slices: flat ? height : SPAN, uSize: SPAN, vSize, area: SPAN * vSize };
}

// Slice and in-slice mask index of a region block, with `y` relative to the lowest slice.
// Masks are always `SPAN` cells wide along u.
function maskSlice(face: number, x: number, y: number, z: number): number {
  if (isFlatFace(face)) return y;
  return face === Face.PositiveX || face === Face.NegativeX ? x : z;
}

function maskOffset(face: number, x: number, y: number, z: number): number {
  if (isFlatFace(face)) return z * SPAN + x;
  return y * SPAN + (face === Face.PositiveX || face === Face.NegativeX ? z : x);
}

/** Region-local block position of mask cell (u, v) in a slice. */
function slicePosition(
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

/** Top and bottom faces lie flat; their slices run along y and their masks along x and z. */
function isFlatFace(face: number): boolean {
  return face === Face.PositiveY || face === Face.NegativeY;
}

/** Faces on the cell boundary can be hidden by neighbors; inner box faces only by the sky. */
function isBoundaryFace(face: number, size: number, inset: number, anchoredTop: boolean): boolean {
  if (face === Face.PositiveY) return anchoredTop || size === 16;
  if (face === Face.NegativeY) return !anchoredTop || size === 16;
  return inset === 0;
}

/**
 * Everything but position and size, so equal keys can merge into one quad. An inset
 * applies to each quad's outline, so inset boxes never widen, and their tops never
 * merge. Side faces stack vertically only for full-height boxes, such as fence posts.
 */
function mergeKey(
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

function keyMaterial(key: number): QuadMaterial {
  const material = (key >>> 8) & 0xf;
  if (material > QuadMaterial.Plant) throw new RangeError(`Invalid material ${material}`);
  return material as QuadMaterial;
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

function faceOf(face: number): Face {
  if (face < Face.PositiveX || face > Face.NegativeZ) throw new RangeError(`Invalid face ${face}`);
  return face as Face;
}

function spriteOf(sprite: number): PlantSprite {
  if (sprite > 5) throw new RangeError(`Invalid plant sprite ${sprite}`);
  return sprite as PlantSprite;
}
