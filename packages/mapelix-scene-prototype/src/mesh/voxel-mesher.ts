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
  VOLUME_HEIGHT,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  type RegionVolume,
} from "./region-volume.js";
import {
  COVER_DEPTH,
  KEY_COVERED,
  NORMAL_LAYER,
  cornerOcclusion,
  faceOf,
  faceSteps,
  isFlatFace,
  keyBox,
  keyMaterial,
  maskOffset,
  maskSlice,
  mergeKey,
  mergeSlice,
  slicePosition,
  sliceLayout,
  traceCoveredAir,
} from "./voxel-faces.js";

const TINT_RADIUS = 2;
const SPAN = BASE_REGION_SPAN;
const STEPS = faceSteps(VOLUME_SIZE);
const NEIGHBOR_COLUMNS = [1, -1, VOLUME_SIZE, -VOLUME_SIZE];
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
  private reached: Uint8Array = new Uint8Array(0);
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

  /** Finds the air under overhangs, eaves, and canopies that the open sky reaches. */
  private traceCoveredAir(): void {
    this.reached = traceCoveredAir(
      {
        size: VOLUME_SIZE,
        layers: VOLUME_HEIGHT,
        roof: this.volume.topSolid.map((y) => y - WORLD_MIN_Y),
        isOpaque: (index) => this.isOpaque(index),
      },
      COVER_DEPTH,
    );
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
    const layout = sliceLayout(face, SPAN, this.high - this.low + 1);
    const keys = new Uint32Array(layout.slices * layout.area);
    const colors = new Uint32Array(layout.slices * layout.area);
    const used = new Uint8Array(layout.slices);

    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        const top = this.volume.topBlock[column]!;
        for (let y = this.columnLow[z * SPAN + x]!; y <= top; y += 1) {
          const slice = maskSlice(face, x, y - this.low, z);
          const mask = slice * layout.area + maskOffset(face, SPAN, x, y - this.low, z);
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN);
          if (this.writeFace(face, index, y, column, keys, colors, mask)) used[slice] = 1;
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
    const neighbor = index + STEPS.normal[face]!;
    const neighborY = y + NORMAL_LAYER[face]!;
    const neighborColumn = column + STEPS.column[face]!;
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
    // Grass sides carry the tinted top color; the shader draws soil below its strip.
    const covered = this.palette.covered[id] === 1 && !isFlatFace(face);
    const color = this.colorOf(id, covered ? Face.PositiveY : face, column);
    const key = mergeKey(this.palette.material[id]!, size, inset, anchoredTop, face);
    keys[mask] = covered ? (key | KEY_COVERED) >>> 0 : key;
    colors[mask] = packQuadWord2(color, occlusion);
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
      const neighborY = y + NORMAL_LAYER[face]!;
      if (neighborY < WORLD_MIN_Y) return false;
      if (neighborY < WORLD_MAX_Y) {
        const neighbor = index + STEPS.normal[face]!;
        const neighborCell = this.cells[neighbor]!;
        const neighborShape = this.palette.shape[neighborCell & PALETTE_ID_MASK]!;
        if (this.isWater(neighborCell) || neighborShape === Shape.Cube) return false;
        if (!this.isOpen(neighbor, neighborY, column + STEPS.column[face]!)) return false;
      }
    }
    keys[mask] = mergeKey(QuadMaterial.Water, size, 0, false, face);
    colors[mask] = packQuadWord2(this.tintOf(TintCode.Water, column), FULLY_LIT);
    return true;
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
    const box = keyBox(key);
    const translucent = material === QuadMaterial.Water || material === QuadMaterial.Glass;
    (translucent ? this.translucent : this.opaque).push(
      packQuadWord0(x, y, z, faceOf(face), material, (key & KEY_COVERED) !== 0),
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
    return cornerOcclusion(STEPS, face, front, frontY, (index, y) => this.isSolidAt(index, y));
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

/** Faces on the cell boundary can be hidden by neighbors; inner box faces only by the sky. */
function isBoundaryFace(face: number, size: number, inset: number, anchoredTop: boolean): boolean {
  if (face === Face.PositiveY) return anchoredTop || size === 16;
  if (face === Face.NegativeY) return !anchoredTop || size === 16;
  return inset === 0;
}

function spriteOf(sprite: number): PlantSprite {
  if (sprite > 5) throw new RangeError(`Invalid plant sprite ${sprite}`);
  return sprite as PlantSprite;
}
