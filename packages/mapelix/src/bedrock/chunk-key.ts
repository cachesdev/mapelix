/** Bedrock LevelDB record tag used for a subchunk value. */
export const SUBCHUNK_TAG = 0x2f;

/** A subchunk key decoded from a Bedrock LevelDB key. */
export interface BedrockSubchunkKey {
  readonly tag: typeof SUBCHUNK_TAG;
  readonly x: number;
  readonly z: number;
  /** 0 is the overworld; non-zero dimensions are written explicitly. */
  readonly dimension: number;
  /** The signed subchunk coordinate. */
  readonly y: number;
}

function readInt32LittleEndian(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt32(offset, true);
}

/**
 * Classifies a Bedrock chunk key as a subchunk key.
 *
 * Overworld subchunks omit the four-byte dimension field.  Nether and End
 * keys, as well as explicitly written overworld keys, include it.
 */
export function classifyChunkKey(key: Uint8Array): BedrockSubchunkKey | undefined {
  const overworldKeyLength = 10;
  const dimensionedKeyLength = 14;

  if (key.byteLength !== overworldKeyLength && key.byteLength !== dimensionedKeyLength) {
    return undefined;
  }

  const tagOffset = key.byteLength === overworldKeyLength ? 8 : 12;
  if (key[tagOffset] !== SUBCHUNK_TAG) {
    return undefined;
  }

  const y = key[tagOffset + 1];
  if (y === undefined) {
    return undefined;
  }

  return {
    tag: SUBCHUNK_TAG,
    x: readInt32LittleEndian(key, 0),
    z: readInt32LittleEndian(key, 4),
    dimension: tagOffset === 8 ? 0 : readInt32LittleEndian(key, 8),
    y: y >= 0x80 ? y - 0x100 : y,
  };
}
