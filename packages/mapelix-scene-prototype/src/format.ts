/**
 * The binary scene region format shared by the Node mesher and the browser viewer.
 *
 * A region is a square of cells. Level 0 regions are full voxel meshes with one cell
 * per block. Higher levels are voxel meshes of cubic cells from 1 to 16 blocks wide,
 * and quad positions count in cells along every axis, height included.
 * Every visible surface is a packed quad of three `uint32` words, so a GPU can draw a
 * region as one instanced quad and rebuild each corner in the vertex shader.
 *
 * Word 0: cell x (7) | cell z (7) << 7 | cell y + 64 (9) << 14 | face (3) << 23 |
 *         material (4) << 26 | covered soil (1) << 30
 * Word 1: width - 1 (7) | height - 1 (9) << 7 | box size - 1 (4) << 16 |
 *         box inset (3) << 20 | box anchored to top (1) << 23 | sprite (3) << 24
 * Word 2: sRGB color (24) | corner occlusion (4 × 2) << 24
 *
 * Width and height run along the face's two tangent axes. Boxes are measured in
 * sixteenths of a cell, so slabs, carpets, snow, and fence posts share one quad type.
 * A covered-soil side, such as a grass block's, is `SOIL_COLOR` with a thin strip of
 * the quad's color along its top edge.
 */

export const REGION_MAGIC = 0x3153_584d; // "MXS1" in little-endian byte order.
export const REGION_FORMAT_VERSION = 2;
export const REGION_HEADER_BYTES = 40;
/** Height map value for a cell without any stored blocks. */
export const EMPTY_HEIGHT = -32768;
/** Lowest overworld block. Quads store their cell y minus `WORLD_MIN_Y` in nine bits. */
export const WORLD_MIN_Y = -64;
export const WORLD_MAX_Y = 320;
/** Packed sRGB soil color under the cover strip of covered-soil sides. */
export const SOIL_COLOR = 0x866043;
/** Blocks covered by one level 0 region along each axis. */
export const BASE_REGION_SPAN = 64;
/** The coarsest level the viewer requests. Level 5 covers 2048 by 2048 blocks. */
export const MAX_REGION_LEVEL = 5;

/** Face directions. Faces 6 and 7 are the two diagonal planes of a crossed plant. */
export const Face = {
  PositiveX: 0,
  NegativeX: 1,
  PositiveY: 2,
  NegativeY: 3,
  PositiveZ: 4,
  NegativeZ: 5,
  CrossA: 6,
  CrossB: 7,
} as const;
export type Face = (typeof Face)[keyof typeof Face];

/** Shading families. The viewer picks lighting and transparency from this field. */
export const QuadMaterial = {
  Solid: 0,
  Foliage: 1,
  Emissive: 2,
  Water: 3,
  Glass: 4,
  Plant: 5,
} as const;
export type QuadMaterial = (typeof QuadMaterial)[keyof typeof QuadMaterial];

/** Procedural cut-out shapes for crossed plant quads. */
export const PlantSprite = {
  Grass: 0,
  Flower: 1,
  Bush: 2,
  Crop: 3,
  Stalk: 4,
  Mushroom: 5,
} as const;
export type PlantSprite = (typeof PlantSprite)[keyof typeof PlantSprite];

/** A box inside one cell. `size` is its height and `inset` its horizontal margin, in sixteenths. */
export interface QuadBox {
  readonly size: number;
  readonly inset: number;
  readonly anchoredTop: boolean;
}

export const FULL_BOX: QuadBox = { size: 16, inset: 0, anchoredTop: false };

export interface Quad {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly face: Face;
  readonly material: QuadMaterial;
  /** A side of soil under a cover, drawn with a strip of `color` along its top edge. */
  readonly coveredSoil: boolean;
  readonly width: number;
  readonly height: number;
  readonly box: QuadBox;
  readonly sprite: PlantSprite;
  /** Packed `0xRRGGBB` sRGB color. */
  readonly color: number;
  /** Four two-bit occlusion levels, corner 0 in the low bits. 3 is fully lit. */
  readonly occlusion: number;
}

export const FULLY_LIT = 0xff;

export function packQuadWord0(
  x: number,
  y: number,
  z: number,
  face: Face,
  material: QuadMaterial,
  coveredSoil = false,
): number {
  const soil = coveredSoil ? 1 << 30 : 0;
  return (x | (z << 7) | ((y - WORLD_MIN_Y) << 14) | (face << 23) | (material << 26) | soil) >>> 0;
}

export function packQuadWord1(
  width: number,
  height: number,
  box: QuadBox,
  sprite: PlantSprite,
): number {
  return (
    ((width - 1) |
      ((height - 1) << 7) |
      ((box.size - 1) << 16) |
      (box.inset << 20) |
      ((box.anchoredTop ? 1 : 0) << 23) |
      (sprite << 24)) >>>
    0
  );
}

export function packQuadWord2(color: number, occlusion: number): number {
  return ((color & 0xffffff) | (occlusion << 24)) >>> 0;
}

/** Reads a packed quad back into named fields. The viewer decodes the same bits in TSL. */
export function unpackQuad(words: Uint32Array, index: number): Quad {
  const word0 = words[index * 3]!;
  const word1 = words[index * 3 + 1]!;
  const word2 = words[index * 3 + 2]!;
  return {
    x: word0 & 0x7f,
    z: (word0 >>> 7) & 0x7f,
    y: ((word0 >>> 14) & 0x1ff) + WORLD_MIN_Y,
    face: asFace((word0 >>> 23) & 0x7),
    material: asMaterial((word0 >>> 26) & 0xf),
    coveredSoil: ((word0 >>> 30) & 1) === 1,
    width: (word1 & 0x7f) + 1,
    height: ((word1 >>> 7) & 0x1ff) + 1,
    box: {
      size: ((word1 >>> 16) & 0xf) + 1,
      inset: (word1 >>> 20) & 0x7,
      anchoredTop: ((word1 >>> 23) & 1) === 1,
    },
    sprite: asSprite((word1 >>> 24) & 0x7),
    color: word2 & 0xffffff,
    occlusion: word2 >>> 24,
  };
}

/** A growable list of packed quads. */
export class QuadList {
  private words = new Uint32Array(3 * 256);
  private length = 0;

  get count(): number {
    return this.length / 3;
  }

  push(word0: number, word1: number, word2: number): void {
    if (this.length + 3 > this.words.length) {
      const grown = new Uint32Array(this.words.length * 2);
      grown.set(this.words);
      this.words = grown;
    }
    this.words[this.length] = word0;
    this.words[this.length + 1] = word1;
    this.words[this.length + 2] = word2;
    this.length += 3;
  }

  finish(): Uint32Array {
    return this.words.slice(0, this.length);
  }
}

/** Mesh output for one region before it is serialized. */
export interface SceneRegion {
  readonly level: number;
  readonly x: number;
  readonly z: number;
  /** Top of the highest visible block in each cell, row-major by z then x. */
  readonly heights: Int16Array;
  /** Lowest and highest block y that any quad reaches. */
  readonly minY: number;
  readonly maxY: number;
  readonly opaque: Uint32Array;
  readonly plants: Uint32Array;
  readonly translucent: Uint32Array;
}

/** A decoded region whose typed arrays view the original bytes without copying. */
export interface DecodedSceneRegion extends SceneRegion {
  readonly originX: number;
  readonly originZ: number;
  readonly cellSize: number;
  readonly gridSize: number;
}

/** Blocks covered by a region at `level` along each axis. */
export function regionSpan(level: number): number {
  return BASE_REGION_SPAN << level;
}

/** Blocks covered by one cell at `level`. Levels 0 and 1 both use one block per cell. */
export function regionCellSize(level: number): number {
  return level <= 1 ? 1 : 1 << (level - 1);
}

/** Cells per region side. Level 0 regions are smaller because they hold full voxels. */
export function regionGridSize(level: number): number {
  return regionSpan(level) / regionCellSize(level);
}

export function encodeSceneRegion(region: SceneRegion): Uint8Array {
  const gridSize = regionGridSize(region.level);
  const quadWords = region.opaque.length + region.plants.length + region.translucent.length;
  const bytes = new Uint8Array(REGION_HEADER_BYTES + gridSize * gridSize * 2 + quadWords * 4);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, REGION_MAGIC, true);
  view.setUint16(4, REGION_FORMAT_VERSION, true);
  view.setUint8(6, region.level);
  view.setInt32(8, region.x, true);
  view.setInt32(12, region.z, true);
  view.setUint32(16, region.opaque.length / 3, true);
  view.setUint32(20, region.plants.length / 3, true);
  view.setUint32(24, region.translucent.length / 3, true);
  view.setInt16(28, region.minY, true);
  view.setInt16(30, region.maxY, true);

  let offset = REGION_HEADER_BYTES;
  bytes.set(
    new Uint8Array(region.heights.buffer, region.heights.byteOffset, gridSize ** 2 * 2),
    offset,
  );
  offset += gridSize * gridSize * 2;
  for (const quads of [region.opaque, region.plants, region.translucent]) {
    bytes.set(new Uint8Array(quads.buffer, quads.byteOffset, quads.byteLength), offset);
    offset += quads.byteLength;
  }
  return bytes;
}

/**
 * Parses a region payload. The input must start on a four-byte boundary, which
 * holds for a fresh `fetch` buffer or a Node `readFile` result copied into its own buffer.
 */
export function decodeSceneRegion(bytes: Uint8Array): DecodedSceneRegion {
  if (bytes.byteLength < REGION_HEADER_BYTES || bytes.byteOffset % 4 !== 0) {
    throw new Error("Scene region payload is truncated or misaligned");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== REGION_MAGIC) throw new Error("Not a Mapelix scene region");
  const version = view.getUint16(4, true);
  if (version !== REGION_FORMAT_VERSION) {
    throw new Error(`Unsupported scene region version ${version}`);
  }

  const level = view.getUint8(6);
  const x = view.getInt32(8, true);
  const z = view.getInt32(12, true);
  const gridSize = regionGridSize(level);
  const opaqueCount = view.getUint32(16, true);
  const plantCount = view.getUint32(20, true);
  const translucentCount = view.getUint32(24, true);
  const quadCount = opaqueCount + plantCount + translucentCount;
  const expected = REGION_HEADER_BYTES + gridSize * gridSize * 2 + quadCount * 12;
  if (bytes.byteLength !== expected) {
    throw new Error(`Scene region has ${bytes.byteLength} bytes, expected ${expected}`);
  }

  let offset = bytes.byteOffset + REGION_HEADER_BYTES;
  const heights = new Int16Array(bytes.buffer, offset, gridSize * gridSize);
  offset += gridSize * gridSize * 2;
  const takeQuads = (count: number): Uint32Array => {
    const quads = new Uint32Array(bytes.buffer, offset, count * 3);
    offset += count * 12;
    return quads;
  };
  const opaque = takeQuads(opaqueCount);
  const plants = takeQuads(plantCount);
  const translucent = takeQuads(translucentCount);

  return {
    level,
    x,
    z,
    originX: x * regionSpan(level),
    originZ: z * regionSpan(level),
    cellSize: regionCellSize(level),
    gridSize,
    heights,
    minY: view.getInt16(28, true),
    maxY: view.getInt16(30, true),
    opaque,
    plants,
    translucent,
  };
}

function asFace(value: number): Face {
  if (value < 0 || value > 7) throw new RangeError(`Invalid quad face ${value}`);
  return value as Face;
}

function asMaterial(value: number): QuadMaterial {
  if (value > QuadMaterial.Plant) throw new RangeError(`Invalid quad material ${value}`);
  return value as QuadMaterial;
}

function asSprite(value: number): PlantSprite {
  if (value > PlantSprite.Mushroom) throw new RangeError(`Invalid plant sprite ${value}`);
  return value as PlantSprite;
}
