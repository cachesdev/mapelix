/** Bedrock LevelDB record tag used for a subchunk value. */
export const SUBCHUNK_TAG = 0x2f;
/** Bedrock LevelDB record tag used for legacy height and two-dimensional biome data. */
export const DATA_2D_TAG = 0x2d;

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

export interface BedrockData2DKey {
  readonly tag: typeof DATA_2D_TAG;
  readonly x: number;
  readonly z: number;
  readonly dimension: number;
}

export type BedrockMapKey = BedrockSubchunkKey | BedrockData2DKey;

/** Cheap filter for LevelDB scans. It does not allocate or decode coordinates. */
export function isMapRecordKey(key: Uint8Array): boolean {
  const tagOffset = key.byteLength === 9 || key.byteLength === 10 ? 8 : 12;
  const tag = key[tagOffset];
  return (
    ((key.byteLength === 10 || key.byteLength === 14) && tag === SUBCHUNK_TAG) ||
    ((key.byteLength === 9 || key.byteLength === 13) && tag === DATA_2D_TAG)
  );
}

/** Decodes either supported map record with one coordinate view allocation. */
export function classifyMapRecordKey(key: Uint8Array): BedrockMapKey | undefined {
  if (!isMapRecordKey(key)) return undefined;
  const tagOffset = key.byteLength === 9 || key.byteLength === 10 ? 8 : 12;
  const tag = key[tagOffset];
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  const location = {
    x: view.getInt32(0, true),
    z: view.getInt32(4, true),
    dimension: tagOffset === 8 ? 0 : view.getInt32(8, true),
  };
  if (tag === DATA_2D_TAG) return { tag, ...location };
  const y = key[tagOffset + 1]!;
  return { tag: SUBCHUNK_TAG, ...location, y: y >= 0x80 ? y - 0x100 : y };
}

/**
 * Classifies a Bedrock chunk key as a subchunk key.
 *
 * Overworld subchunks omit the four-byte dimension field.  Nether and End
 * keys, as well as explicitly written overworld keys, include it.
 */
export function classifyChunkKey(key: Uint8Array): BedrockSubchunkKey | undefined {
  const decoded = classifyMapRecordKey(key);
  return decoded?.tag === SUBCHUNK_TAG ? decoded : undefined;
}

/** Classifies the legacy Data2D height and biome record for a chunk. */
export function classifyData2DKey(key: Uint8Array): BedrockData2DKey | undefined {
  const decoded = classifyMapRecordKey(key);
  return decoded?.tag === DATA_2D_TAG ? decoded : undefined;
}
