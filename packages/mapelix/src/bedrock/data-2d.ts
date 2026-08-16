import { classifyData2DKey, type BedrockData2DKey } from "./chunk-key.js";

const columnCount = 16 * 16;
const heightBytes = columnCount * 2;

export interface DecodedData2D {
  readonly key: BedrockData2DKey;
  readonly heights: Int16Array;
  readonly biomes: Uint16Array;
}

/** Decodes legacy Data2D records with 8-bit or 16-bit biome identifiers. */
export function decodeData2D(
  keyBytes: Uint8Array,
  valueBytes: Uint8Array,
): DecodedData2D | undefined {
  const key = classifyData2DKey(keyBytes);
  if (key === undefined) {
    return undefined;
  }
  const biomeBytes = valueBytes.byteLength - heightBytes;
  if (biomeBytes !== columnCount && biomeBytes !== columnCount * 2) {
    throw new Error(
      `Malformed Bedrock Data2D: expected 768 or 1024 bytes, received ${valueBytes.byteLength}`,
    );
  }

  const view = new DataView(valueBytes.buffer, valueBytes.byteOffset, valueBytes.byteLength);
  const heights = new Int16Array(columnCount);
  const biomes = new Uint16Array(columnCount);
  for (let index = 0; index < columnCount; index += 1) {
    heights[index] = view.getInt16(index * 2, true);
    biomes[index] =
      biomeBytes === columnCount
        ? valueBytes[heightBytes + index]!
        : view.getUint16(heightBytes + index * 2, true);
  }
  return { key, heights, biomes };
}

/** Data2D columns are stored in Bedrock's X-major, Z-minor order. */
export function data2DBiomeAt(data: DecodedData2D, localX: number, localZ: number): number {
  return data.biomes[localX * 16 + localZ]!;
}
