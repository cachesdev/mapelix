/**
 * The texture atlas format shared by the Node atlas builder and the browser viewer.
 *
 * An atlas is one RGBA image of square tiles, `columns` wide and `rows` high, with a mipmap
 * chain down to one pixel per tile. Each tile is a texture, or one frame of an animated texture
 * whose frames follow it. Every level halves the tile size, so tiles never share a texel at any
 * level and a shader reads them with exact texel fetches, without bleeding.
 *
 * Header (little-endian, 24 bytes): magic u32, version u16, tile size u16, columns u16,
 * rows u16, tiles u32, levels u16, reserved u16 and u32.
 * Then 8 bytes per tile: average color and coverage u32 (`0xCCRRGGBB`), frames u16, ticks per
 * frame u8, reserved u8. Then each level's pixels, largest first.
 */

export const ATLAS_MAGIC = 0x3154_584d; // "MXT1" in little-endian byte order.
export const ATLAS_FORMAT_VERSION = 1;
export const ATLAS_HEADER_BYTES = 24;
export const ATLAS_TILE_INFO_BYTES = 8;
/** Largest atlas side; every WebGL 2 and WebGPU device of interest samples 4096 pixels. */
export const MAX_ATLAS_SIDE = 4096;
/** Tiles a quad texture word can address. */
export const MAX_ATLAS_TILES = 1 << 14;

export interface AtlasTileInfo {
  /** Average sRGB color of the visible pixels, `0xRRGGBB`. */
  readonly average: number;
  /** Average alpha, 0 to 255. */
  readonly coverage: number;
  /** Frames of an animation starting at this tile, 1 for a still texture, 0 for a later frame. */
  readonly frames: number;
  /** Game ticks (1/20 s) per frame. */
  readonly ticksPerFrame: number;
}

export interface TextureAtlas {
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly tiles: readonly AtlasTileInfo[];
  /** RGBA pixels of each level, `columns * (tileSize >> level)` wide. */
  readonly levels: readonly Uint8Array[];
}

export function atlasLevelCount(tileSize: number): number {
  return Math.log2(tileSize) + 1;
}

export function atlasLevelSize(
  atlas: Pick<TextureAtlas, "tileSize" | "columns" | "rows">,
  level: number,
): {
  width: number;
  height: number;
} {
  const tile = atlas.tileSize >> level;
  return { width: atlas.columns * tile, height: atlas.rows * tile };
}

/** GPU bytes of an atlas with its mipmaps. */
export function atlasBytes(atlas: Pick<TextureAtlas, "tileSize" | "columns" | "rows">): number {
  let bytes = 0;
  for (let level = 0; level < atlasLevelCount(atlas.tileSize); level++) {
    const { width, height } = atlasLevelSize(atlas, level);
    bytes += width * height * 4;
  }
  return bytes;
}

function checkShape(tileSize: number, columns: number, rows: number, tiles: number): void {
  if (!Number.isInteger(Math.log2(tileSize)) || tileSize < 1 || tileSize > 256) {
    throw new RangeError(`Atlas tile size ${tileSize} is not a power of two up to 256`);
  }
  if (
    columns < 1 ||
    rows < 1 ||
    columns * tileSize > MAX_ATLAS_SIDE ||
    rows * tileSize > MAX_ATLAS_SIDE
  ) {
    throw new RangeError(`Atlas of ${columns} by ${rows} tiles of ${tileSize} is too large`);
  }
  if (tiles < 1 || tiles > columns * rows || tiles > MAX_ATLAS_TILES) {
    throw new RangeError(`Atlas holds ${tiles} tiles in ${columns} by ${rows}`);
  }
}

export function encodeTextureAtlas(atlas: TextureAtlas): Uint8Array {
  const { tileSize, columns, rows, tiles, levels } = atlas;
  checkShape(tileSize, columns, rows, tiles.length);
  const count = atlasLevelCount(tileSize);
  if (levels.length !== count) throw new RangeError(`Atlas needs ${count} levels`);
  const bytes = new Uint8Array(
    ATLAS_HEADER_BYTES + tiles.length * ATLAS_TILE_INFO_BYTES + atlasBytes(atlas),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, ATLAS_MAGIC, true);
  view.setUint16(4, ATLAS_FORMAT_VERSION, true);
  view.setUint16(6, tileSize, true);
  view.setUint16(8, columns, true);
  view.setUint16(10, rows, true);
  view.setUint32(12, tiles.length, true);
  view.setUint16(16, count, true);
  let offset = ATLAS_HEADER_BYTES;
  for (const tile of tiles) {
    view.setUint32(offset, ((tile.coverage << 24) | (tile.average & 0xff_ffff)) >>> 0, true);
    view.setUint16(offset + 4, tile.frames, true);
    view.setUint8(offset + 6, tile.ticksPerFrame);
    offset += ATLAS_TILE_INFO_BYTES;
  }
  for (const [level, pixels] of levels.entries()) {
    const { width, height } = atlasLevelSize(atlas, level);
    if (pixels.byteLength !== width * height * 4)
      throw new RangeError(`Atlas level ${level} has the wrong size`);
    bytes.set(pixels, offset);
    offset += pixels.byteLength;
  }
  return bytes;
}

/** Parses an atlas; the level arrays view the input bytes without copying. */
export function decodeTextureAtlas(bytes: Uint8Array): TextureAtlas {
  if (bytes.byteLength < ATLAS_HEADER_BYTES) throw new Error("Texture atlas is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ATLAS_MAGIC) throw new Error("Not a Mapelix texture atlas");
  const version = view.getUint16(4, true);
  if (version !== ATLAS_FORMAT_VERSION)
    throw new Error(`Unsupported texture atlas version ${version}`);
  const tileSize = view.getUint16(6, true);
  const columns = view.getUint16(8, true);
  const rows = view.getUint16(10, true);
  const count = view.getUint32(12, true);
  checkShape(tileSize, columns, rows, count);
  if (view.getUint16(16, true) !== atlasLevelCount(tileSize))
    throw new Error("Texture atlas has the wrong levels");
  const expected =
    ATLAS_HEADER_BYTES + count * ATLAS_TILE_INFO_BYTES + atlasBytes({ tileSize, columns, rows });
  if (bytes.byteLength !== expected) {
    throw new Error(`Texture atlas has ${bytes.byteLength} bytes, expected ${expected}`);
  }
  const tiles: AtlasTileInfo[] = [];
  let offset = ATLAS_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    const packed = view.getUint32(offset, true);
    tiles.push({
      average: packed & 0xff_ffff,
      coverage: packed >>> 24,
      frames: view.getUint16(offset + 4, true),
      ticksPerFrame: view.getUint8(offset + 6),
    });
    offset += ATLAS_TILE_INFO_BYTES;
  }
  const levels: Uint8Array[] = [];
  for (let level = 0; level < atlasLevelCount(tileSize); level++) {
    const { width, height } = atlasLevelSize({ tileSize, columns, rows }, level);
    levels.push(bytes.subarray(offset, offset + width * height * 4));
    offset += width * height * 4;
  }
  return { tileSize, columns, rows, tiles, levels };
}

/**
 * The fourth word of a textured quad: atlas tile (14 bits), quarter turns (2 bits) and whether
 * the texture takes the quad's biome color (bit 16). Bit 17 marks a quad with a texture; a quad
 * without one keeps its color.
 */
export const QUAD_TEXTURED = 1 << 17;
export const QUAD_TEXTURE_TINTED = 1 << 16;

export function packQuadTexture(tile: number, rotation: number, tinted: boolean): number {
  return (
    (QUAD_TEXTURED |
      (tinted ? QUAD_TEXTURE_TINTED : 0) |
      ((rotation & 3) << 14) |
      (tile & 0x3fff)) >>>
    0
  );
}

export function unpackQuadTexture(
  word: number,
): { readonly tile: number; readonly rotation: number; readonly tinted: boolean } | undefined {
  if ((word & QUAD_TEXTURED) === 0) return undefined;
  return {
    tile: word & 0x3fff,
    rotation: (word >>> 14) & 3,
    tinted: (word & QUAD_TEXTURE_TINTED) !== 0,
  };
}
