import {
  DATA_2D_TAG,
  DATA_3D_TAG,
  SUBCHUNK_TAG,
  classifyMapRecordKey,
  data2DBiomeAt,
  decodeData2D,
  decodeSubchunk,
  type DecodedData2D,
  type DecodedSubchunk,
} from "@mapelix/prototype/bedrock";

import type { LiveRecord, WorldDatabase } from "../leveldb/world-database.js";
import { Data3DBiomes } from "./data-3d-biomes.js";

export type Dimension = "overworld" | "nether" | "the-end";

const DIMENSION_IDS: Readonly<Record<Dimension, number>> = {
  overworld: 0,
  nether: 1,
  "the-end": 2,
};

/** Stored records for one chunk column, before any subchunk is decoded. */
export interface ChunkRecords {
  readonly x: number;
  readonly z: number;
  /** Subchunk records sorted from the top of the world down. */
  readonly sections: readonly SectionRecord[];
  readonly biomes: ChunkBiomes;
}

export interface SectionRecord {
  readonly y: number;
  readonly record: LiveRecord;
}

/** A chunk column with every subchunk decoded, sorted from the bottom up. */
export interface DecodedChunk {
  readonly x: number;
  readonly z: number;
  readonly sections: readonly DecodedSubchunk[];
  readonly biomes: ChunkBiomes;
}

/**
 * Biome lookups for one chunk. Data3D stores a biome per voxel; older worlds
 * only have the Data2D column biome, which stays the fallback.
 */
export class ChunkBiomes {
  private readonly data3D: Data3DBiomes | undefined;
  private readonly data2D: DecodedData2D | undefined;

  constructor(data3D: Data3DBiomes | undefined, data2D: DecodedData2D | undefined) {
    this.data3D = data3D;
    this.data2D = data2D;
  }

  at(localX: number, y: number, localZ: number): number | undefined {
    return (
      this.data3D?.at(localX, y, localZ) ??
      (this.data2D === undefined ? undefined : data2DBiomeAt(this.data2D, localX, localZ))
    );
  }
}

/** Loads chunk columns from a seekable world database, with a small decoded-chunk cache. */
export class ChunkSource {
  private readonly database: WorldDatabase;
  private readonly dimension: number;
  private readonly decoded = new Map<string, DecodedChunk | undefined>();
  private readonly maxDecodedChunks: number;

  constructor(database: WorldDatabase, dimension: Dimension, maxDecodedChunks = 128) {
    this.database = database;
    this.dimension = DIMENSION_IDS[dimension];
    this.maxDecodedChunks = maxDecodedChunks;
  }

  /** Reads the raw records of a chunk. Returns undefined for chunks the world never stored. */
  records(chunkX: number, chunkZ: number): ChunkRecords | undefined {
    const sections: SectionRecord[] = [];
    let data3D: Data3DBiomes | undefined;
    let data2D: DecodedData2D | undefined;
    for (const record of this.database.readPrefix(this.prefix(chunkX, chunkZ))) {
      const key = classifyMapRecordKey(record.key);
      if (key === undefined || key.dimension !== this.dimension) continue;
      if (key.tag === SUBCHUNK_TAG) sections.push({ y: key.y, record });
      else if (key.tag === DATA_3D_TAG) data3D = new Data3DBiomes(record.value);
      else if (key.tag === DATA_2D_TAG) data2D = decodeData2D(record.key, record.value);
    }
    if (sections.length === 0) return undefined;

    sections.sort((left, right) => right.y - left.y);
    return { x: chunkX, z: chunkZ, sections, biomes: new ChunkBiomes(data3D, data2D) };
  }

  /** Decodes every subchunk of a chunk, including palette states for block shapes. */
  chunk(chunkX: number, chunkZ: number): DecodedChunk | undefined {
    const id = `${chunkX},${chunkZ}`;
    if (this.decoded.has(id)) {
      const cached = this.decoded.get(id);
      this.decoded.delete(id);
      this.decoded.set(id, cached);
      return cached;
    }

    const records = this.records(chunkX, chunkZ);
    const chunk =
      records === undefined
        ? undefined
        : {
            x: chunkX,
            z: chunkZ,
            biomes: records.biomes,
            sections: records.sections
              .map((section) => decodeSection(section))
              .filter((section) => section !== undefined)
              .sort((left, right) => left.y - right.y),
          };
    this.decoded.set(id, chunk);
    if (this.decoded.size > this.maxDecodedChunks) {
      const oldest = this.decoded.keys().next().value;
      if (oldest !== undefined) this.decoded.delete(oldest);
    }
    return chunk;
  }

  private prefix(chunkX: number, chunkZ: number): Uint8Array {
    const prefix = new Uint8Array(this.dimension === 0 ? 8 : 12);
    const view = new DataView(prefix.buffer);
    view.setInt32(0, chunkX, true);
    view.setInt32(4, chunkZ, true);
    if (this.dimension !== 0) view.setInt32(8, this.dimension, true);
    return prefix;
  }
}

export function decodeSection(section: SectionRecord): DecodedSubchunk | undefined {
  return decodeSubchunk(section.record.key, section.record.value, { includeStates: true });
}
