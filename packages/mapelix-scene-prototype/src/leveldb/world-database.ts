import { closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";

import {
  TABLE_BLOCK_TRAILER_SIZE,
  readTableBlock,
  visitLevelDbRecords,
} from "@mapelix/prototype/bedrock";

import {
  BlockCache,
  SeekableTable,
  compareBytes,
  comparePrefix,
  type RecordVersion,
} from "./seekable-table.js";

export interface LiveRecord {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export interface WorldDatabaseOptions {
  /** Decompressed table blocks kept in memory for neighboring lookups. */
  readonly blockCacheBytes?: number;
}

/**
 * Read-only access to a Bedrock world's LevelDB directory without a full scan.
 *
 * Tables are opened lazily by block. Log files hold the newest writes and are
 * small, so they are parsed once. Every lookup applies the same last-write-wins
 * and tombstone rules as a full scan: the highest sequence number wins.
 */
export class WorldDatabase {
  private readonly tables: readonly SeekableTable[];
  private readonly log: readonly RecordVersion[];
  private readonly descriptors: readonly number[];

  private constructor(
    tables: readonly SeekableTable[],
    log: readonly RecordVersion[],
    descriptors: readonly number[],
  ) {
    this.tables = tables;
    this.log = log;
    this.descriptors = descriptors;
  }

  static open(worldDirectory: string, options: WorldDatabaseOptions = {}): WorldDatabase {
    const directory = join(worldDirectory, "db");
    const names = readdirSync(directory).sort((left, right) => left.localeCompare(right));
    const blocks = new BlockCache(options.blockCacheBytes ?? 64 * 1024 * 1024);
    const descriptors: number[] = [];
    const tables: SeekableTable[] = [];
    for (const name of names.filter((entry) => /\.(?:ldb|sst)$/i.test(entry))) {
      const descriptor = openSync(join(directory, name), "r");
      descriptors.push(descriptor);
      const table = SeekableTable.open(
        {
          name,
          size: fstatSync(descriptor).size,
          read: (offset, size) => readAt(descriptor, offset, size),
        },
        blocks,
        decodeTableBlockNatively,
      );
      if (table !== undefined) tables.push(table);
    }

    const log: RecordVersion[] = [];
    for (const name of names.filter((entry) => /\.log$/i.test(entry))) {
      visitLevelDbRecords(
        { name, bytes: readFileSync(join(directory, name)) },
        (key, value, sequence) => {
          log.push({
            key: key.slice(),
            value: value?.slice() ?? new Uint8Array(),
            sequence,
            deleted: value === undefined,
          });
        },
      );
    }
    log.sort((left, right) => compareBytes(left.key, right.key));
    return new WorldDatabase(tables, log, descriptors);
  }

  /** Returns the live value of every key that starts with `prefix`. */
  readPrefix(prefix: Uint8Array): LiveRecord[] {
    const latest = new Map<string, RecordVersion>();
    const keep = (version: RecordVersion): void => {
      const id = keyId(version.key);
      const previous = latest.get(id);
      if (previous === undefined || version.sequence >= previous.sequence) {
        latest.set(id, { ...version, key: version.key.slice() });
      }
    };

    for (const table of this.tables) table.scanPrefix(prefix, keep);
    for (let index = this.firstLogIndex(prefix); index < this.log.length; index += 1) {
      const version = this.log[index]!;
      if (comparePrefix(version.key, prefix) !== 0) break;
      keep(version);
    }

    const records: LiveRecord[] = [];
    for (const version of latest.values()) {
      if (!version.deleted) records.push({ key: version.key, value: version.value });
    }
    return records;
  }

  close(): void {
    for (const descriptor of this.descriptors) closeSync(descriptor);
  }

  private firstLogIndex(prefix: Uint8Array): number {
    let low = 0;
    let high = this.log.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareBytes(this.log[middle]!.key, prefix) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

/** Bedrock compression ids: 2 is zlib, 4 is raw deflate. */
const ZLIB = 2;
const RAW_DEFLATE = 4;

/**
 * Inflates Bedrock's zlib blocks with Node's native zlib, which is several times
 * faster than the portable decoder. Anything unusual falls back to that decoder.
 */
function decodeTableBlockNatively(blockWithTrailer: Uint8Array, source: string): Uint8Array {
  const size = blockWithTrailer.length - TABLE_BLOCK_TRAILER_SIZE;
  const compression = blockWithTrailer[size];
  const raw = blockWithTrailer.subarray(0, size);
  try {
    if (compression === RAW_DEFLATE) return inflateRawSync(raw);
    if (compression === ZLIB) return inflateSync(raw);
  } catch {
    // Some tools mislabel the compression; the portable decoder tries every wrapper.
  }
  return readTableBlock(blockWithTrailer, source);
}

function readAt(descriptor: number, offset: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  const read = readSync(descriptor, bytes, 0, size, offset);
  if (read !== size) throw new Error(`Short LevelDB read: ${read} of ${size} bytes`);
  return bytes;
}

function keyId(key: Uint8Array): string {
  return String.fromCharCode(...key);
}
