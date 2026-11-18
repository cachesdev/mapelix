import {
  BASE_REGION_SPAN,
  EMPTY_HEIGHT,
  Face,
  FULLY_LIT,
  QUAD_LAVA_FLAG,
  QUAD_MODEL_FLAG,
  QuadList,
  QuadMaterial,
  WORLD_MAX_Y,
  WORLD_MIN_Y,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  packModelWord1,
  modelBoxId,
  partitionLavaQuads,
  type PlantSprite,
  type SceneRegion,
} from "../format.js";
import { blockModelParts, type ModelBounds } from "../blocks/block-models.js";
import { lavaFlowDirection } from "./lava-flow.js";
import { blendColumnTints } from "./biome-tints.js";
import type { GeometryMode } from "../dimensions.js";
import { BlockPalette, PALETTE_ID_MASK, Shape, TintCode, WATERLOGGED } from "./block-palette.js";
import { QUAD_CUTOUT } from "../textures/atlas-format.js";
import { sheetFaceWord } from "../textures/sheet-faces.js";
import {
  NO_BLOCK,
  VOLUME_LAYER,
  VOLUME_MARGIN,
  VOLUME_SIZE,
  cellIndex,
  type RegionVolume,
} from "./region-volume.js";
import {
  COVER_DEPTH,
  KEY_COVERED,
  KEY_LAVA,
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
  findOpenAir,
} from "./voxel-faces.js";

const TINT_RADIUS = 2;
const SPAN = BASE_REGION_SPAN;
const STEPS = faceSteps(VOLUME_SIZE);
const NEIGHBOR_COLUMNS = [1, -1, VOLUME_SIZE, -VOLUME_SIZE];
const WATER_SURFACE_SIZE = 14;

/**
 * Turns a level 0 volume into packed quads. Surface mode culls sealed interiors;
 * dimension modes keep internal faces for enclosed Nether caves and End islands. With a
 * textured palette, thin blocks with holes (`BlockPalette.cutout`, like leaf litter) hide
 * nothing; with `cutout`, cubes with holes like leaves hide nothing either: the faces behind
 * and between them are drawn, as Minecraft's fancy leaves are.
 */
export function meshRegionVolume(
  volume: RegionVolume,
  palette: BlockPalette,
  regionX: number,
  regionZ: number,
  geometry: GeometryMode = "surface",
  cutout = false,
): SceneRegion {
  return new VoxelMesher(volume, palette, geometry, cutout).mesh(regionX, regionZ);
}

class VoxelMesher {
  private readonly geometry: GeometryMode;
  private readonly volume: RegionVolume;
  private readonly palette: BlockPalette;
  private readonly cells: Uint16Array;
  private readonly baseY: number;
  private readonly limitY: number;
  private readonly caveTints = new Map<number, Uint32Array[]>();
  /** Covered air cells that connect to the sky. Open air above `topSolid` is implied. */
  private reached: Uint8Array = new Uint8Array(0);
  /** Lowest open cell of each volume column, in layers above `WORLD_MIN_Y`. */
  private lowestOpen: Int16Array = new Int16Array(0);
  private readonly tints: Uint32Array[];
  private readonly opaque: QuadList;
  private readonly plants: QuadList;
  private readonly translucent: QuadList;
  /** A textured palette's face texture words, or undefined for a plain mesh. */
  private readonly textureWords: Uint32Array | undefined;
  /** The texture word of each face in the slice masks being written. */
  private maskTextures: Uint32Array | undefined;
  /** Lowest block per region column that can own a visible face. */
  private readonly columnLow = new Int16Array(SPAN * SPAN);
  private low = WORLD_MAX_Y;
  private high = NO_BLOCK;
  private minY = WORLD_MAX_Y;
  private maxY = WORLD_MIN_Y;
  private hasModels = false;
  /** Blocks with holes, see `BlockPalette.cutout`; textured palettes only. */
  private readonly cutout: Uint8Array | undefined;
  /** Whether cubes with holes are seen through too, see `meshRegionVolume`. */
  private readonly cutoutCubes: boolean;

  constructor(
    volume: RegionVolume,
    palette: BlockPalette,
    geometry: GeometryMode,
    cutout: boolean,
  ) {
    this.geometry = geometry;
    this.cutout = palette.textures !== undefined ? palette.cutout : undefined;
    this.cutoutCubes = cutout;
    this.volume = volume;
    this.palette = palette;
    const textured = palette.textures !== undefined;
    this.textureWords = textured ? palette.textureWords : undefined;
    this.opaque = new QuadList(textured);
    this.plants = new QuadList(textured);
    this.translucent = new QuadList(textured);
    this.cells = volume.cells;
    this.baseY = volume.baseY ?? WORLD_MIN_Y;
    this.limitY = volume.limitY ?? WORLD_MAX_Y;
    this.low = this.minY = this.limitY;
    this.maxY = this.baseY;
    this.tints = blendColumnTints(
      { biomes: volume.biomes, stride: VOLUME_SIZE },
      VOLUME_MARGIN,
      SPAN,
      TINT_RADIUS,
    );
  }

  mesh(regionX: number, regionZ: number): SceneRegion {
    this.findOpenAir();
    this.findColumnRanges();
    if (this.high >= this.low) {
      for (let face = 0; face < 6; face += 1) this.meshFace(face);
      this.meshPlants();
      if (this.hasModels) this.meshModels();
    }
    const opaqueTextures = this.opaque.finishTextures();
    const region: SceneRegion = {
      level: 0,
      x: regionX,
      z: regionZ,
      heights: this.heights(),
      minY: this.minY === this.limitY ? 0 : this.minY,
      maxY: this.minY === this.limitY ? 0 : this.maxY,
      opaque: partitionLavaQuads(this.opaque.finish(), opaqueTextures),
      plants: this.plants.finish(),
      translucent: this.translucent.finish(),
    };
    if (opaqueTextures === undefined) return region;
    return {
      ...region,
      textures: {
        opaque: opaqueTextures,
        plants: this.plants.finishTextures()!,
        translucent: this.translucent.finishTextures()!,
      },
    };
  }

  /** Finds the air under overhangs, eaves, canopies, and platforms that the open sky reaches. */
  private findOpenAir(): void {
    if (this.geometry !== "surface") {
      // Legacy dimension floors stay unchanged; caves also keep enclosed negative-Y faces.
      this.lowestOpen = new Int16Array(VOLUME_LAYER).fill(
        this.volume.window === undefined ? 1 - this.baseY : 1,
      );
      return;
    }
    const open = findOpenAir(
      {
        size: VOLUME_SIZE,
        layers: this.limitY - this.baseY,
        roof: this.volume.topSolid.map((y) => y - this.baseY),
        isOpaque: (index) => this.isOpaque(index),
      },
      COVER_DEPTH,
    );
    this.reached = open.reached;
    this.lowestOpen = open.lowest;
  }

  /**
   * A block can only own a visible face if an open cell touches it, so the lowest open
   * cell around a column bounds the blocks worth testing there.
   */
  private findColumnRanges(): void {
    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        let lowest = this.lowestOpen[column]!;
        for (const step of NEIGHBOR_COLUMNS) {
          lowest = Math.min(lowest, this.lowestOpen[column + step]!);
        }
        const low = Math.max(this.volume.window?.minY ?? this.baseY, lowest + this.baseY - 1);
        this.columnLow[z * SPAN + x] = low;
        const top = this.columnTop(column);
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
    const textures =
      this.textureWords === undefined ? undefined : new Uint32Array(layout.slices * layout.area);
    this.maskTextures = textures;
    const used = new Uint8Array(layout.slices);

    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        const top = this.columnTop(column);
        for (let y = this.columnLow[z * SPAN + x]!; y <= top; y += 1) {
          const slice = maskSlice(face, x, y - this.low, z);
          const mask = slice * layout.area + maskOffset(face, SPAN, x, y - this.low, z);
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN, this.baseY);
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
        (key, color, u, v, width, height, texture) => {
          this.emit(key, color, face, slice, u, v, width, height, texture);
        },
        textures?.subarray(start, start + layout.area),
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
    if (shape === Shape.Model) {
      this.hasModels = true;
      return false;
    }
    if (shape === Shape.Lava) return this.writeLavaFace(face, index, y, column, keys, colors, mask);
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
      if (neighborY < this.baseY) return false;
      if (neighborY < this.limitY && !this.seesThrough(this.cells[neighbor]!)) {
        if (this.hides(this.cells[neighbor]!, face, id)) return false;
        if (!this.isOpen(neighbor, neighborY, neighborColumn)) return false;
      }
    } else if (
      !this.isOpen(index, y, column) &&
      !(neighborY < this.limitY && this.seesThrough(this.cells[neighbor]!))
    ) {
      // A lower block such as a path under leaf litter shows through the litter's holes.
      return false;
    }

    const occlusion = boundary
      ? this.occlusion(face, neighbor, neighborY)
      : this.occlusion(face, index, y);
    // Grass sides carry the tinted top color; the shader draws soil below its strip.
    const covered = this.palette.covered[id] === 1 && !isFlatFace(face);
    const color = this.colorOf(id, covered ? Face.PositiveY : face, column, y);
    const key = mergeKey(this.palette.material[id]!, size, inset, anchoredTop, face);
    keys[mask] = covered ? (key | KEY_COVERED) >>> 0 : key;
    colors[mask] = packQuadWord2(color, occlusion);
    if (this.maskTextures !== undefined) {
      const word = this.textureWords![id * 6 + face]!;
      this.maskTextures[mask] =
        word !== 0 && this.cutoutCubes && this.cutout?.[id] === 1
          ? (word | QUAD_CUTOUT) >>> 0
          : word;
    }
    return true;
  }

  /** Whether a neighbor's holes show this face, so it never hides it. */
  private seesThrough(cell: number): boolean {
    const kind = this.cutout?.[cell & PALETTE_ID_MASK];
    return kind === 2 || (kind === 1 && this.cutoutCubes);
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
    const surface = y + 1 >= this.limitY || !this.isWater(this.cells[index + VOLUME_LAYER]!);
    const size = surface ? WATER_SURFACE_SIZE : 16;
    if (face === Face.PositiveY && surface) {
      if (!this.isOpen(index, y, column)) return false;
    } else {
      const neighborY = y + NORMAL_LAYER[face]!;
      if (neighborY < this.baseY) return false;
      if (neighborY < this.limitY) {
        const neighbor = index + STEPS.normal[face]!;
        const neighborCell = this.cells[neighbor]!;
        const neighborShape = this.palette.shape[neighborCell & PALETTE_ID_MASK]!;
        if (this.isWater(neighborCell) || neighborShape === Shape.Cube) return false;
        if (!this.isOpen(neighbor, neighborY, column + STEPS.column[face]!)) return false;
      }
    }
    keys[mask] = mergeKey(QuadMaterial.Water, size, 0, false, face);
    colors[mask] = packQuadWord2(this.tintOf(TintCode.Water, column, y), FULLY_LIT);
    if (this.maskTextures !== undefined) this.maskTextures[mask] = this.palette.waterWord;
    return true;
  }

  private writeLavaFace(
    face: number,
    index: number,
    y: number,
    column: number,
    keys: Uint32Array,
    colors: Uint32Array,
    mask: number,
  ): boolean {
    const id = this.cells[index]! & PALETTE_ID_MASK;
    const above =
      y + 1 < this.limitY &&
      this.palette.shape[this.cells[index + VOLUME_LAYER]! & PALETTE_ID_MASK] === Shape.Lava;
    const fill = above ? 16 : this.palette.boxSize[id]!;
    const neighborY = y + NORMAL_LAYER[face]!;
    if (neighborY < this.baseY) return false;
    if (face === Face.PositiveY && fill < 16) {
      if (!this.isOpen(index, y, column)) return false;
    } else if (neighborY < this.limitY) {
      const neighbor = index + STEPS.normal[face]!;
      const neighborId = this.cells[neighbor]! & PALETTE_ID_MASK;
      const neighborShape = this.palette.shape[neighborId]!;
      if (neighborShape === Shape.Cube) return false;
      if (
        neighborShape === Shape.Lava &&
        (isFlatFace(face) || this.lavaHeight(neighbor, fill) >= fill)
      )
        return false;
      if (!this.isOpen(neighbor, neighborY, column + STEPS.column[face]!)) return false;
    }
    const flow = lavaFlowDirection(
      this.lavaHeight(index + 1, fill),
      this.lavaHeight(index - 1, fill),
      this.lavaHeight(index + VOLUME_SIZE, fill),
      this.lavaHeight(index - VOLUME_SIZE, fill),
    );
    keys[mask] =
      (mergeKey(QuadMaterial.Emissive, fill, 0, false, face) | KEY_LAVA | (flow << 12)) >>> 0;
    colors[mask] = packQuadWord2(this.colorOf(id, face, column, y), FULLY_LIT);
    if (this.maskTextures !== undefined)
      this.maskTextures[mask] = this.textureWords![id * 6 + face]!;
    return true;
  }

  private lavaHeight(index: number, blockedFill: number): number {
    const id = this.cells[index]! & PALETTE_ID_MASK;
    if (this.palette.shape[id] === Shape.Cube) return blockedFill;
    if (this.palette.shape[id] !== Shape.Lava) return 0;
    return this.palette.shape[(this.cells[index + VOLUME_LAYER] ?? 0) & PALETTE_ID_MASK] ===
      Shape.Lava
      ? 16
      : this.palette.boxSize[id]!;
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
    texture: number,
  ): void {
    const [x, y, z] = slicePosition(face, slice, u, v, this.low);
    const material = keyMaterial(key);
    const box = keyBox(key);
    const translucent = material === QuadMaterial.Water || material === QuadMaterial.Glass;
    (translucent ? this.translucent : this.opaque).push(
      packQuadWord0(x, y, z, faceOf(face), material, (key & KEY_COVERED) !== 0),
      packQuadWord1(width, height, box, 0) |
        ((key & KEY_LAVA) !== 0 ? QUAD_LAVA_FLAG | (((key >>> 12) & 15) << 28) : 0),
      color,
      texture,
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
        const top = this.columnTop(column);
        for (let y = this.columnLow[z * SPAN + x]!; y <= top; y += 1) {
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN, this.baseY);
          const id = this.cells[index]! & PALETTE_ID_MASK;
          if (palette.shape[id] !== Shape.Plant || !this.isOpen(index, y, column)) continue;
          const box = {
            size: palette.boxSize[id]!,
            inset: palette.boxInset[id]!,
            anchoredTop: false,
          };
          const word1 = packQuadWord1(1, 1, box, spriteOf(palette.sprite[id]!));
          const word2 = packQuadWord2(this.colorOf(id, Face.PositiveY, column, y), FULLY_LIT);
          const texture = this.textureWords === undefined ? 0 : palette.crossWords[id]!;
          this.plants.push(
            packQuadWord0(x, y, z, Face.CrossA, QuadMaterial.Plant),
            word1,
            word2,
            texture,
          );
          this.plants.push(
            packQuadWord0(x, y, z, Face.CrossB, QuadMaterial.Plant),
            word1,
            word2,
            texture,
          );
          if (this.geometry !== "surface") {
            this.minY = Math.min(this.minY, y);
            this.maxY = Math.max(this.maxY, y + box.size / 16);
          }
        }
      }
    }
  }

  /** Detailed models occupy the existing opaque/glass streams; all faces remain 12 bytes. */
  private meshModels(): void {
    const { palette } = this;
    for (let z = 0; z < SPAN; z++)
      for (let x = 0; x < SPAN; x++) {
        const column = (z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN;
        for (let y = this.columnLow[z * SPAN + x]!; y <= this.columnTop(column); y++) {
          const index = cellIndex(x + VOLUME_MARGIN, y, z + VOLUME_MARGIN, this.baseY);
          const id = this.cells[index]! & PALETTE_ID_MASK;
          const model = palette.models[id];
          if (model === undefined || !this.isOpen(index, y, column)) continue;
          const parts = blockModelParts(model, (dx, dy, dz) => {
            if (y + dy < this.baseY || y + dy >= this.limitY) return { opaque: false };
            const other =
              this.cells[index + dx + dy * VOLUME_LAYER + dz * VOLUME_SIZE]! & PALETTE_ID_MASK;
            return {
              opaque: palette.shape[other] === Shape.Cube,
              glass: palette.shape[other] === Shape.Glass,
              model: palette.models[other],
            };
          });
          const material = palette.material[id]! as QuadMaterial;
          const list = material === QuadMaterial.Glass ? this.translucent : this.opaque;
          for (const [partIndex, part] of parts.entries())
            for (let face = 0; face < 6; face++) {
              if (
                parts.some(
                  (other, otherIndex) =>
                    otherIndex !== partIndex && coversModelFace(part.bounds, other.bounds, face),
                )
              )
                continue;
              const axis = face >> 1;
              const plane = part.bounds[axis + ((face & 1) === 0 ? 3 : 0)]!;
              const boundary = plane === ((face & 1) === 0 ? 16 : 0);
              const neighborY = y + NORMAL_LAYER[face]!;
              if (boundary && neighborY >= this.baseY && neighborY < this.limitY) {
                const neighbor = index + STEPS.normal[face]!;
                if (
                  this.hides(this.cells[neighbor]!, face, id) ||
                  !this.isOpen(neighbor, neighborY, column + STEPS.column[face]!)
                )
                  continue;
              }
              const color = part.color ?? this.colorOf(id, face, column, y);
              const occlusion =
                material === QuadMaterial.Emissive
                  ? FULLY_LIT
                  : this.occlusion(
                      face,
                      boundary ? index + STEPS.normal[face]! : index,
                      boundary ? neighborY : y,
                    );
              list.push(
                packQuadWord0(x, y, z, faceOf(face), material) | QUAD_MODEL_FLAG,
                packModelWord1(modelBoxId(part.bounds)),
                packQuadWord2(color, occlusion),
                this.textureWords === undefined || part.color !== undefined
                  ? 0
                  : part.sheet === undefined
                    ? this.textureWords[id * 6 + face]!
                    : sheetFaceWord(
                        this.textureWords[id * 6 + face]!,
                        part.bounds,
                        face,
                        part.sheet,
                      ),
              );

              this.minY = Math.min(this.minY, y);
              this.maxY = Math.max(this.maxY, y + 1);
            }
        }
      }
  }

  private heights(): Int16Array {
    const heights = new Int16Array(SPAN * SPAN);
    for (let z = 0; z < SPAN; z += 1) {
      for (let x = 0; x < SPAN; x += 1) {
        const top = this.columnTop((z + VOLUME_MARGIN) * VOLUME_SIZE + x + VOLUME_MARGIN);
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
    if (
      this.geometry !== "surface" ||
      y > this.volume.topSolid[column]! ||
      this.reached[index] === 1
    )
      return true;
    // A partial lava surface has open room above it, but remains opaque to sky tracing below.
    return (
      this.palette.shape[this.cells[index]! & PALETTE_ID_MASK] === Shape.Lava &&
      (y + 1 > this.volume.topSolid[column]! || this.reached[index + VOLUME_LAYER] === 1)
    );
  }

  private isSolidAt(index: number, y: number): boolean {
    return y >= this.baseY && y < this.limitY && this.isOpaque(index);
  }

  private isOpaque(index: number): boolean {
    return this.palette.isOpaque(this.cells[index]! & PALETTE_ID_MASK);
  }

  private isWater(cell: number): boolean {
    return (cell & WATERLOGGED) !== 0 || this.palette.shape[cell & PALETTE_ID_MASK] === Shape.Water;
  }

  private columnTop(column: number): number {
    return Math.min(this.volume.topBlock[column]!, (this.volume.window?.maxY ?? this.limitY) - 1);
  }

  private colorOf(id: number, face: number, column: number, y: number): number {
    const tint = this.palette.tints[id * 6 + face]!;
    return tint === TintCode.None
      ? this.palette.colors[id * 6 + face]!
      : this.tintOf(tint, column, y);
  }

  private tintOf(tint: number, column: number, y: number): number {
    const x = (column % VOLUME_SIZE) - VOLUME_MARGIN;
    const z = Math.floor(column / VOLUME_SIZE) - VOLUME_MARGIN;
    let tints = this.tints;
    if (this.volume.window !== undefined && this.volume.biomeAt !== undefined) {
      const cached = this.caveTints.get(y);
      if (cached !== undefined) tints = cached;
      else {
        const biomes = new Int16Array(VOLUME_LAYER);
        for (let bz = 0; bz < VOLUME_SIZE; bz++)
          for (let bx = 0; bx < VOLUME_SIZE; bx++)
            biomes[bz * VOLUME_SIZE + bx] = this.volume.biomeAt(bx, y, bz) ?? -1;
        tints = blendColumnTints({ biomes, stride: VOLUME_SIZE }, VOLUME_MARGIN, SPAN, TINT_RADIUS);
        this.caveTints.set(y, tints);
      }
    }
    return tints[tint]![z * SPAN + x]!;
  }
}

/** Drops internal faces fully covered by another part, without creating new bounds variants. */
function coversModelFace(a: ModelBounds, b: ModelBounds, face: number): boolean {
  const axis = face >> 1;
  const positive = (face & 1) === 0;
  const plane = a[axis + (positive ? 3 : 0)]!;
  if (
    positive ? b[axis]! > plane || b[axis + 3]! <= plane : b[axis]! >= plane || b[axis + 3]! < plane
  )
    return false;
  for (let tangent = 0; tangent < 3; tangent++) {
    if (tangent !== axis && (b[tangent]! > a[tangent]! || b[tangent + 3]! < a[tangent + 3]!))
      return false;
  }
  return true;
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
