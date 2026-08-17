import { classifyData3DKey, type BedrockData3DKey } from "./chunk-key.js";

const columnCount = 16 * 16;
const heightBytes = columnCount * 2;
const biomeCount = 16 * 16 * 16;
const overworldSectionCount = 24;

export interface DecodedBiomeStorage {
  readonly bitsPerBiome: number;
  readonly palette: readonly number[];
  /** Palette indexes in Bedrock's x-major, z-middle, y-minor order. */
  readonly indexes: Uint16Array;
}

export interface DecodedData3D {
  readonly key: BedrockData3DKey;
  readonly heights: Int16Array;
  /** Biome storages in the same ascending order as the chunk's existing block sections. */
  readonly storages: readonly DecodedBiomeStorage[];
}

function malformed(message: string): Error {
  return new Error(`Malformed Bedrock Data3D: ${message}`);
}

function readInt32(bytes: Uint8Array, offset: number, description: string): number {
  if (offset < 0 || offset > bytes.byteLength - 4) {
    throw malformed(`unexpected end of input while reading ${description}`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}

function decodeIndexes(
  bytes: Uint8Array,
  offset: number,
  bitsPerBiome: number,
): { readonly indexes: Uint16Array; readonly nextOffset: number } {
  const indexes = new Uint16Array(biomeCount);
  if (bitsPerBiome === 0) return { indexes, nextOffset: offset };
  if (bitsPerBiome > 16) throw malformed(`unsupported bits per biome ${bitsPerBiome}`);

  const biomesPerWord = Math.floor(32 / bitsPerBiome);
  const wordCount = Math.ceil(biomeCount / biomesPerWord);
  const byteLength = wordCount * 4;
  if (offset > bytes.byteLength - byteLength) {
    throw malformed("unexpected end of input while reading packed biome indexes");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, byteLength);
  const valueMask = (1 << bitsPerBiome) - 1;
  for (let index = 0; index < biomeCount; index += 1) {
    const wordIndex = Math.floor(index / biomesPerWord);
    const shift = (index % biomesPerWord) * bitsPerBiome;
    indexes[index] = (view.getUint32(wordIndex * 4, true) >>> shift) & valueMask;
  }
  return { indexes, nextOffset: offset + byteLength };
}

function decodeStorage(
  bytes: Uint8Array,
  offset: number,
): { readonly storage: DecodedBiomeStorage; readonly nextOffset: number } {
  const header = bytes[offset];
  if (header === undefined) throw malformed("unexpected end of input while reading biome header");
  if ((header & 1) !== 1) throw malformed("runtime biome palettes are not supported");

  const bitsPerBiome = header >>> 1;
  const packed = decodeIndexes(bytes, offset + 1, bitsPerBiome);
  const paletteLength =
    bitsPerBiome === 0 ? 1 : readInt32(bytes, packed.nextOffset, "biome palette length");
  if (paletteLength < 1 || paletteLength > biomeCount) {
    throw malformed(`invalid biome palette length ${paletteLength}`);
  }

  let nextOffset = packed.nextOffset + (bitsPerBiome === 0 ? 0 : 4);
  const palette: number[] = [];
  for (let index = 0; index < paletteLength; index += 1) {
    palette.push(readInt32(bytes, nextOffset, `biome palette entry ${index}`));
    nextOffset += 4;
  }
  for (const paletteIndex of packed.indexes) {
    if (paletteIndex >= palette.length) {
      throw malformed(
        `packed palette index ${paletteIndex} is outside palette length ${palette.length}`,
      );
    }
  }
  return {
    storage: { bitsPerBiome, palette, indexes: packed.indexes },
    nextOffset,
  };
}

/** Decodes the modern overworld Data3D heightmap and sequential biome storages. */
export function decodeData3D(
  keyBytes: Uint8Array,
  valueBytes: Uint8Array,
): DecodedData3D | undefined {
  const key = classifyData3DKey(keyBytes);
  if (key === undefined) return undefined;
  if (valueBytes.byteLength < heightBytes + 1) {
    throw malformed(`expected at least 513 bytes, received ${valueBytes.byteLength}`);
  }

  const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
  const heights = new Int16Array(columnCount);
  for (let index = 0; index < columnCount; index += 1) {
    heights[index] = view.getInt16(index * 2, true);
  }

  const storages: DecodedBiomeStorage[] = [];
  let offset = heightBytes;
  while (offset < valueBytes.byteLength && storages.length < overworldSectionCount) {
    const header = valueBytes[offset];
    if (header === 0xff || header === undefined || (header & 1) === 0) break;
    const decoded = decodeStorage(valueBytes, offset);
    storages.push(decoded.storage);
    offset = decoded.nextOffset;
  }
  return { key, heights, storages };
}

/** Returns the numeric biome ID for one world-height voxel in a decoded chunk. */
export function data3DBiomeAt(
  data: DecodedData3D,
  sectionYs: readonly number[],
  localX: number,
  worldY: number,
  localZ: number,
): number | undefined {
  const sectionY = Math.floor(worldY / 16);
  const storage = data.storages[sectionYs.indexOf(sectionY)];
  if (storage === undefined) return undefined;
  const localY = worldY - sectionY * 16;
  const paletteIndex = storage.indexes[localX * 256 + localZ * 16 + localY];
  return paletteIndex === undefined ? undefined : storage.palette[paletteIndex];
}
