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
import { DIMENSIONS, parseDimension, type Dimension, type DimensionConfig } from "../dimensions.js";
import { Data3DBiomes } from "./data-3d-biomes.js";
import { isBlockEntityKey, readBedColors, readBannerColors, type BedColors } from "./bed-colors.js";

export type { Dimension } from "../dimensions.js";

/** Stored records for one chunk column, before any subchunk is decoded. */
export interface ChunkRecords {
  readonly x: number;
  readonly z: number;
  /** Subchunk records sorted from the top of the world down. */
  readonly sections: readonly SectionRecord[];
  readonly biomes: ChunkBiomes;
  readonly bedColors: BedColors;
  readonly bannerColors: BedColors;
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
  readonly bedColors: BedColors;
  readonly bannerColors: BedColors;
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
  readonly config: DimensionConfig;
  private readonly database: Pick<WorldDatabase, "readPrefix">;
  private readonly dimension: number;
  private readonly decoded = new Map<string, DecodedChunk | undefined>();
  private readonly maxDecodedChunks: number;
  /** Shared across cave depths: bounded by source section, never by window variants. */
  private readonly decodedSections = new Map<string, DecodedSubchunk | undefined>();

  constructor(
    database: Pick<WorldDatabase, "readPrefix">,
    dimension: Dimension,
    maxDecodedChunks = 128,
  ) {
    this.database = database;
    this.config = DIMENSIONS[parseDimension(dimension)];
    this.dimension = this.config.storageId;
    this.maxDecodedChunks = maxDecodedChunks;
  }

  /** Reads the raw records of a chunk. Returns undefined for chunks the world never stored. */
  records(chunkX: number, chunkZ: number): ChunkRecords | undefined {
    const sections: SectionRecord[] = [];
    let data3D: Data3DBiomes | undefined;
    let data2D: DecodedData2D | undefined;
    let blockEntities: Uint8Array | undefined;
    for (const record of this.database.readPrefix(this.prefix(chunkX, chunkZ))) {
      if (isBlockEntityKey(record.key, this.dimension)) {
        blockEntities = record.value;
        continue;
      }
      const key = classifyMapRecordKey(record.key);
      if (key === undefined || key.dimension !== this.dimension) continue;
      if (key.tag === SUBCHUNK_TAG) {
        if (key.y >= this.config.minY / 16 && key.y < this.config.maxY / 16) {
          sections.push({ y: key.y, record });
        }
      } else if (key.tag === DATA_3D_TAG)
        data3D = new Data3DBiomes(record.value, this.config.minY, this.config.maxY);
      else if (key.tag === DATA_2D_TAG) data2D = decodeData2D(record.key, record.value);
    }
    if (sections.length === 0) return undefined;

    sections.sort((left, right) => right.y - left.y);
    return {
      x: chunkX,
      z: chunkZ,
      sections,
      biomes: new ChunkBiomes(data3D, data2D),
      bedColors: readBedColors(blockEntities, chunkX, chunkZ, this.config.minY, this.config.maxY),
      bannerColors: readBannerColors(
        blockEntities,
        chunkX,
        chunkZ,
        this.config.minY,
        this.config.maxY,
      ),
    };
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
            bedColors: records.bedColors,
            bannerColors: records.bannerColors,
            sections: records.sections
              .map((section) => decodeSection(section))
              .filter(
                (section): section is DecodedSubchunk =>
                  section !== undefined &&
                  section.y >= this.config.minY / 16 &&
                  section.y < this.config.maxY / 16,
              )
              .sort((left, right) => left.y - right.y),
          };
    this.decoded.set(id, chunk);
    if (this.decoded.size > this.maxDecodedChunks) {
      const oldest = this.decoded.keys().next().value;
      if (oldest !== undefined) this.decoded.delete(oldest);
    }
    return chunk;
  }

  /** Decodes only source sections touching a padded cave window. The world is a fixed snapshot. */
  chunkRange(chunkX: number, chunkZ: number, minY: number, maxY: number): DecodedChunk | undefined {
    const records = this.records(chunkX, chunkZ);
    if (records === undefined) return undefined;
    const sections: DecodedSubchunk[] = [];
    for (const record of records.sections) {
      if (record.y * 16 < minY || record.y * 16 >= maxY) continue;
      const key = `${chunkX},${chunkZ},${record.y}`;
      let section = this.decodedSections.get(key);
      if (!this.decodedSections.has(key)) section = decodeSection(record);
      this.decodedSections.delete(key);
      this.decodedSections.set(key, section);
      if (this.decodedSections.size > 256) {
        this.decodedSections.delete(this.decodedSections.keys().next().value!);
      }
      if (section !== undefined) sections.push(section);
    }
    sections.sort((a, b) => a.y - b.y);
    return { ...records, sections };
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
