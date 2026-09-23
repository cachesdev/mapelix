import {
  TABLE_BLOCK_TRAILER_SIZE,
  TABLE_FOOTER_SIZE,
  parseInternalKey,
  parseTableBlock,
  readBlockHandle,
  readTableBlock,
  readTableFooter,
  type BlockHandle,
  type InternalKey,
  type TableBlockEntry,
} from "@mapelix/prototype/bedrock";

/** Reads `size` bytes at `offset` from a table file. */
export type ReadTableBytes = (offset: number, size: number) => Uint8Array;

/** Decompresses a block read together with its five-byte trailer. */
export type DecodeTableBlock = (blockWithTrailer: Uint8Array, source: string) => Uint8Array;

export interface TableFile {
  readonly name: string;
  readonly size: number;
  readonly read: ReadTableBytes;
}

/** One stored version of a key, including tombstones. */
export interface RecordVersion extends InternalKey {
  readonly value: Uint8Array;
}

interface IndexEntry {
  /** User key part of the index separator. Every key in the block is at most this key. */
  readonly lastKey: Uint8Array;
  readonly handle: BlockHandle;
}

/**
 * A LevelDB table that loads only the blocks a lookup needs.
 *
 * Opening reads the footer, the index block, and the first data block. Prefix
 * scans then binary-search the index and decompress the few blocks that can hold
 * matching keys, instead of parsing the whole file.
 */
export class SeekableTable {
  readonly name: string;
  private readonly file: TableFile;
  private readonly index: readonly IndexEntry[];
  private readonly smallestKey: Uint8Array;
  /** The last index separator, which is at least as large as every key in the table. */
  private readonly largestKey: Uint8Array;
  private readonly blocks: BlockCache;
  private readonly decode: DecodeTableBlock;

  private constructor(
    file: TableFile,
    index: readonly IndexEntry[],
    smallestKey: Uint8Array,
    blocks: BlockCache,
    decode: DecodeTableBlock,
  ) {
    this.name = file.name;
    this.file = file;
    this.index = index;
    this.smallestKey = smallestKey;
    this.largestKey = index[index.length - 1]!.lastKey;
    this.blocks = blocks;
    this.decode = decode;
  }

  static open(
    file: TableFile,
    blocks: BlockCache,
    decode: DecodeTableBlock = readTableBlock,
  ): SeekableTable | undefined {
    if (file.size < TABLE_FOOTER_SIZE) throw new Error(`${file.name}: truncated LevelDB table`);
    const footer = file.read(file.size - TABLE_FOOTER_SIZE, TABLE_FOOTER_SIZE);
    const indexBlock = readHandle(file, readTableFooter(footer, file.name), decode);
    const index = parseTableBlock(indexBlock, file.name).map((entry) => ({
      lastKey: parseInternalKey(entry.key, file.name).key,
      handle: readBlockHandle(entry.value, file.name),
    }));
    const firstBlock = index[0];
    if (firstBlock === undefined) return undefined;
    const firstEntries = parseTableBlock(readHandle(file, firstBlock.handle, decode), file.name);
    const firstEntry = firstEntries[0];
    if (firstEntry === undefined) return undefined;
    const smallestKey = parseInternalKey(firstEntry.key, file.name).key.slice();
    return new SeekableTable(file, index, smallestKey, blocks, decode);
  }

  /** Visits every version of every key that starts with `prefix`, in key order. */
  scanPrefix(prefix: Uint8Array, visit: (version: RecordVersion) => void): void {
    if (comparePrefix(this.smallestKey, prefix) > 0) return;
    if (comparePrefix(this.largestKey, prefix) < 0) return;
    const start = this.firstBlockAtOrAfter(prefix);
    for (let blockIndex = start; blockIndex < this.index.length; blockIndex += 1) {
      const entries = this.readBlock(blockIndex);
      for (let entry = firstEntryAtOrAfter(entries, prefix); entry < entries.length; entry += 1) {
        const { key, value } = entries[entry]!;
        if (compareUserKey(key, prefix) > 0) return;
        visit({ ...parseInternalKey(key, this.name), value });
      }
    }
  }

  private firstBlockAtOrAfter(key: Uint8Array): number {
    let low = 0;
    let high = this.index.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compareBytes(this.index[middle]!.lastKey, key) < 0) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private readBlock(blockIndex: number): readonly TableBlockEntry[] {
    const handle = this.index[blockIndex]!.handle;
    const cacheKey = `${this.name}:${handle.offset}`;
    const cached = this.blocks.get(cacheKey);
    if (cached !== undefined) return cached;
    const block = readHandle(this.file, handle, this.decode);
    const entries = parseTableBlock(block, this.name);
    this.blocks.set(cacheKey, entries, block.byteLength);
    return entries;
  }
}

/** A byte-bounded least-recently-used cache of parsed table blocks. */
export class BlockCache {
  private readonly entries = new Map<string, { entries: TableBlockEntry[]; bytes: number }>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes;
  }

  get(key: string): TableBlockEntry[] | undefined {
    const cached = this.entries.get(key);
    if (cached === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, cached);
    return cached.entries;
  }

  set(key: string, entries: TableBlockEntry[], bytes: number): void {
    this.entries.set(key, { entries, bytes });
    this.bytes += bytes;
    for (const [oldestKey, oldest] of this.entries) {
      if (this.bytes <= this.maxBytes) break;
      this.entries.delete(oldestKey);
      this.bytes -= oldest.bytes;
    }
  }
}

/** Binary-searches a block for the first entry whose user key is at or after `prefix`. */
function firstEntryAtOrAfter(entries: readonly TableBlockEntry[], prefix: Uint8Array): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareUserKey(entries[middle]!.key, prefix) < 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** `comparePrefix` for the user key inside an internal key, which ends in an 8-byte tag. */
function compareUserKey(internalKey: Uint8Array, prefix: Uint8Array): number {
  return comparePrefix(internalKey, prefix, internalKey.length - 8);
}

function readHandle(file: TableFile, handle: BlockHandle, decode: DecodeTableBlock): Uint8Array {
  return decode(file.read(handle.offset, handle.size + TABLE_BLOCK_TRAILER_SIZE), file.name);
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Compares only the first `prefix.length` bytes, so every key with the prefix compares equal. */
export function comparePrefix(key: Uint8Array, prefix: Uint8Array, keyLength = key.length): number {
  const length = Math.min(keyLength, prefix.length);
  for (let index = 0; index < length; index += 1) {
    const difference = key[index]! - prefix[index]!;
    if (difference !== 0) return difference;
  }
  return keyLength < prefix.length ? -1 : 0;
}
