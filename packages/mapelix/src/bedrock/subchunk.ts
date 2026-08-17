import { classifyChunkKey, type BedrockSubchunkKey } from "./chunk-key.js";
import { blockNameFromPaletteEntry, readLittleEndianNbtCompound } from "./little-endian-nbt.js";

const blockCount = 16 * 16 * 16;
const maxPaletteEntries = blockCount;

export interface DecodedSubchunkStorage {
  readonly bitsPerBlock: number;
  /** Block names in palette order. */
  readonly palette: readonly string[];
  /** Palette indexes in Bedrock's x-major, z-middle, y-minor order. */
  readonly indexes: Uint16Array;
}

export interface DecodedSubchunk {
  readonly key: BedrockSubchunkKey;
  readonly version: 8 | 9;
  /** Signed subchunk Y from the v9 value, or from the key for v8. */
  readonly y: number;
  readonly primary: DecodedSubchunkStorage;
  /** Includes primary storage followed by optional waterlogging storage. */
  readonly storages: readonly DecodedSubchunkStorage[];
}

function malformed(message: string): Error {
  return new Error(`Malformed Bedrock subchunk: ${message}`);
}

function readUint32LittleEndian(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset > bytes.byteLength - 4) {
    throw malformed("unexpected end of input while reading palette length");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function decodeIndexes(
  bytes: Uint8Array,
  offset: number,
  bitsPerBlock: number,
): { indexes: Uint16Array; nextOffset: number } {
  const indexes = new Uint16Array(blockCount);
  if (bitsPerBlock === 0) {
    return { indexes, nextOffset: offset };
  }
  if (bitsPerBlock > 32) {
    throw malformed(`unsupported bits per block ${bitsPerBlock}`);
  }

  const blocksPerWord = Math.floor(32 / bitsPerBlock);
  if (blocksPerWord === 0) {
    throw malformed(`unsupported bits per block ${bitsPerBlock}`);
  }
  const wordCount = Math.ceil(blockCount / blocksPerWord);
  const byteLength = wordCount * 4;
  if (offset > bytes.byteLength - byteLength) {
    throw malformed("unexpected end of input while reading packed block indexes");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, byteLength);
  const valueMask = bitsPerBlock === 32 ? 0xffffffff : (1 << bitsPerBlock) - 1;
  for (let index = 0; index < blockCount; index += 1) {
    const wordIndex = Math.floor(index / blocksPerWord);
    const shift = (index % blocksPerWord) * bitsPerBlock;
    indexes[index] = (view.getUint32(wordIndex * 4, true) >>> shift) & valueMask;
  }
  return { indexes, nextOffset: offset + byteLength };
}

function decodeStorage(
  bytes: Uint8Array,
  offset: number,
): { storage: DecodedSubchunkStorage; nextOffset: number } {
  const header = bytes[offset];
  if (header === undefined) {
    throw malformed("unexpected end of input while reading storage header");
  }
  if ((header & 1) !== 0) {
    throw malformed("non-persistent palette storage is not supported");
  }

  const bitsPerBlock = header >>> 1;
  const packed = decodeIndexes(bytes, offset + 1, bitsPerBlock);
  if (bitsPerBlock === 0) {
    try {
      const entry = readLittleEndianNbtCompound(bytes, packed.nextOffset);
      return {
        storage: {
          bitsPerBlock,
          palette: [blockNameFromPaletteEntry(entry)],
          indexes: packed.indexes,
        },
        nextOffset: entry.nextOffset,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw malformed(`invalid constant palette entry: ${message}`);
    }
  }

  const paletteLength = readUint32LittleEndian(bytes, packed.nextOffset);
  if (paletteLength === 0 || paletteLength > maxPaletteEntries) {
    throw malformed(`invalid palette length ${paletteLength}`);
  }

  let nextOffset = packed.nextOffset + 4;
  const palette: string[] = [];
  for (let index = 0; index < paletteLength; index += 1) {
    try {
      const entry = readLittleEndianNbtCompound(bytes, nextOffset);
      palette.push(blockNameFromPaletteEntry(entry));
      nextOffset = entry.nextOffset;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw malformed(`invalid palette entry ${index}: ${message}`);
    }
  }

  for (const paletteIndex of packed.indexes) {
    if (paletteIndex >= palette.length) {
      throw malformed(
        `packed palette index ${paletteIndex} is outside palette length ${palette.length}`,
      );
    }
  }
  return { storage: { bitsPerBlock, palette, indexes: packed.indexes }, nextOffset };
}

/**
 * Decodes a v8 or v9 Bedrock subchunk record.  Non-subchunk keys return
 * undefined so callers can pass every LevelDB record through this function.
 */
export function decodeSubchunk(
  keyBytes: Uint8Array,
  valueBytes: Uint8Array,
): DecodedSubchunk | undefined {
  const key = classifyChunkKey(keyBytes);
  if (key === undefined) {
    return undefined;
  }

  const version = valueBytes[0];
  if (version !== 8 && version !== 9) {
    throw new Error(
      `Unsupported Bedrock subchunk version ${version ?? "missing"}; only v8 and v9 are supported`,
    );
  }
  const storageCount = valueBytes[1];
  if (storageCount === undefined || storageCount === 0) {
    throw malformed("missing primary storage");
  }

  let offset = version === 9 ? 3 : 2;
  if (version === 9 && valueBytes[2] === undefined) {
    throw malformed("missing v9 signed subchunk Y");
  }
  const storedY = valueBytes[2];
  const y =
    version === 9 && storedY !== undefined ? (storedY >= 0x80 ? storedY - 0x100 : storedY) : key.y;

  const storages: DecodedSubchunkStorage[] = [];
  for (let storageIndex = 0; storageIndex < storageCount; storageIndex += 1) {
    const decoded = decodeStorage(valueBytes, offset);
    storages.push(decoded.storage);
    offset = decoded.nextOffset;
  }
  if (offset !== valueBytes.byteLength) {
    throw malformed(`unexpected trailing data after ${storageCount} storage area(s)`);
  }

  const primary = storages[0];
  if (primary === undefined) {
    throw malformed("missing primary storage");
  }
  return { key, version, y, primary, storages };
}
