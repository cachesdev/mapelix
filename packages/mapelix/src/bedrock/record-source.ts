import { inflate, inflateRaw } from "pako";

/** A LevelDB file already loaded by the caller. No file-system access is used. */
export interface NamedLevelDbFile {
  name: string;
  bytes: Uint8Array;
}

/** A live key/value pair after LevelDB sequence numbers and tombstones are applied. */
export interface LevelDbRecord {
  key: Uint8Array;
  value: Uint8Array;
  sequence: bigint;
  source: string;
}

/** Controls which LevelDB keys are retained by a reader. */
export interface LevelDbRecordOptions {
  readonly includeKey?: (key: Uint8Array) => boolean;
  /** Returns a compact value to retain in a key index, or undefined to keep the value lazy. */
  readonly retainValue?: (key: Uint8Array, value: Uint8Array) => Uint8Array | undefined;
}

/** A live record location without its potentially large value. */
export interface LevelDbRecordIndexEntry {
  readonly key: Uint8Array;
  readonly sequence: bigint;
  readonly source: string;
  readonly value?: Uint8Array;
}

interface VersionedRecord extends LevelDbRecord {
  deleted: boolean;
  order: number;
}

interface VersionedIndexEntry extends LevelDbRecordIndexEntry {
  deleted: boolean;
  order: number;
}

export interface LevelDbRecordIndex {
  addFile(file: NamedLevelDbFile): void;
  /** Removes and yields records so callers can transform large indexes without a duplicate peak. */
  drainRecords(): IterableIterator<LevelDbRecordIndexEntry>;
  records(): LevelDbRecordIndexEntry[];
}

interface BlockHandle {
  offset: number;
  size: number;
}

const LOG_BLOCK_SIZE = 32 * 1024;
const LDB_MAGIC = [0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb];

/**
 * Reads the `.log` and `.ldb`/`.sst` files of a Bedrock LevelDB directory.
 *
 * The result contains only live records. A delete record suppresses every older
 * value for its key. Files with other names (for example CURRENT and MANIFEST)
 * are ignored because they do not contain world records.
 */
export function readLevelDbRecords(
  files: Iterable<NamedLevelDbFile>,
  options: LevelDbRecordOptions = {},
): LevelDbRecord[] {
  const latest = new Map<string, VersionedRecord>();
  let order = 0;

  const add = (
    key: Uint8Array,
    value: Uint8Array | undefined,
    sequence: bigint,
    source: string,
  ): void => {
    if (options.includeKey !== undefined && !options.includeKey(key)) {
      return;
    }
    const encodedKey = hex(key);
    const previous = latest.get(encodedKey);
    const deleted = value === undefined;
    const candidate: VersionedRecord = {
      key: key.slice(),
      value: value?.slice() ?? new Uint8Array(),
      sequence,
      source,
      deleted,
      order,
    };

    if (
      !previous ||
      sequence > previous.sequence ||
      (sequence === previous.sequence && order > previous.order)
    ) {
      // Keep tombstones in the comparison set, but omit them from the result.
      latest.set(encodedKey, candidate);
    }
    order++;
  };

  for (const file of [...files].sort((left, right) => left.name.localeCompare(right.name))) {
    parseFile(file, add);
  }

  return [...latest.values()]
    .filter((record) => !record.deleted)
    .map(({ deleted: _deleted, order: _order, ...record }) => record);
}

/**
 * Creates an incremental key-only index.
 *
 * Values are discarded while each file is parsed. This keeps memory use tied
 * to the number of selected keys instead of the total size of world values.
 */
export function createLevelDbRecordIndex(options: LevelDbRecordOptions = {}): LevelDbRecordIndex {
  const latest = new Map<string, VersionedIndexEntry>();
  let order = 0;

  const add = (
    key: Uint8Array,
    value: Uint8Array | undefined,
    sequence: bigint,
    source: string,
  ): void => {
    if (options.includeKey !== undefined && !options.includeKey(key)) {
      return;
    }
    const encodedKey = hex(key);
    const previous = latest.get(encodedKey);
    const retainedValue =
      value === undefined ? undefined : options.retainValue?.(key, value)?.slice();
    const candidate: VersionedIndexEntry = {
      key: key.slice(),
      sequence,
      source,
      deleted: value === undefined,
      order,
      ...(retainedValue === undefined ? {} : { value: retainedValue }),
    };

    if (
      !previous ||
      sequence > previous.sequence ||
      (sequence === previous.sequence && order > previous.order)
    ) {
      latest.set(encodedKey, candidate);
    }
    order++;
  };

  return {
    addFile(file): void {
      parseFile(file, add);
    },
    *drainRecords(): IterableIterator<LevelDbRecordIndexEntry> {
      for (const [encodedKey, record] of latest) {
        latest.delete(encodedKey);
        if (!record.deleted) {
          yield record;
        }
      }
    },
    records(): LevelDbRecordIndexEntry[] {
      return [...latest.values()]
        .filter((record) => !record.deleted)
        .map(({ deleted: _deleted, order: _order, ...record }) => record);
    },
  };
}

function parseFile(
  file: NamedLevelDbFile,
  add: (key: Uint8Array, value: Uint8Array | undefined, sequence: bigint, source: string) => void,
): void {
  const lowerName = file.name.toLowerCase();
  if (lowerName.endsWith(".log")) {
    parseLog(file.bytes, file.name, add);
  } else if (lowerName.endsWith(".ldb") || lowerName.endsWith(".sst")) {
    parseTable(file.bytes, file.name, add);
  }
}

function parseLog(
  bytes: Uint8Array,
  source: string,
  add: (key: Uint8Array, value: Uint8Array | undefined, sequence: bigint, source: string) => void,
): void {
  let offset = 0;
  let fragments: Uint8Array[] | undefined;

  while (offset < bytes.length) {
    const blockOffset = offset % LOG_BLOCK_SIZE;
    const remaining = LOG_BLOCK_SIZE - blockOffset;
    if (remaining < 7) {
      offset += remaining;
      continue;
    }
    if (offset + 7 > bytes.length) {
      break;
    }

    const length = bytes[offset + 4]! | (bytes[offset + 5]! << 8);
    const type = bytes[offset + 6]!;
    offset += 7;
    if (length > bytes.length - offset || length > remaining - 7) {
      throw new Error(`${source}: invalid LevelDB log record length`);
    }
    const payload = bytes.subarray(offset, offset + length);
    offset += length;

    if (type === 0) {
      // A zero-filled block trailer is not a logical record.
      continue;
    }
    if (type === 1) {
      if (fragments) {
        throw new Error(`${source}: incomplete fragmented LevelDB log record`);
      }
      parseWriteBatch(payload, source, add);
    } else if (type === 2) {
      fragments = [payload];
    } else if (type === 3) {
      if (!fragments)
        throw new Error(`${source}: LevelDB log middle fragment without first fragment`);
      fragments.push(payload);
    } else if (type === 4) {
      if (!fragments)
        throw new Error(`${source}: LevelDB log last fragment without first fragment`);
      fragments.push(payload);
      parseWriteBatch(join(fragments), source, add);
      fragments = undefined;
    } else {
      throw new Error(`${source}: unknown LevelDB log record type ${type}`);
    }
  }

  if (fragments) throw new Error(`${source}: incomplete fragmented LevelDB log record`);
}

function parseWriteBatch(
  batch: Uint8Array,
  source: string,
  add: (key: Uint8Array, value: Uint8Array | undefined, sequence: bigint, source: string) => void,
): void {
  if (batch.length < 12) throw new Error(`${source}: truncated LevelDB write batch`);
  const startSequence = fixed64(batch, 0);
  const count = fixed32(batch, 8);
  let offset = 12;

  for (let index = 0; index < count; index++) {
    if (offset >= batch.length) throw new Error(`${source}: truncated LevelDB write batch entry`);
    const type = batch[offset++]!;
    const key = readLengthPrefixed(batch, offset, source);
    offset = key.next;
    if (type === 1) {
      const value = readLengthPrefixed(batch, offset, source);
      offset = value.next;
      add(key.value, value.value, startSequence + BigInt(index), source);
    } else if (type === 0) {
      add(key.value, undefined, startSequence + BigInt(index), source);
    } else {
      throw new Error(`${source}: unknown LevelDB write batch entry type ${type}`);
    }
  }
  if (offset !== batch.length) throw new Error(`${source}: trailing bytes in LevelDB write batch`);
}

function parseTable(
  bytes: Uint8Array,
  source: string,
  add: (key: Uint8Array, value: Uint8Array | undefined, sequence: bigint, source: string) => void,
): void {
  if (
    bytes.length < 48 ||
    !LDB_MAGIC.every((byte, index) => bytes[bytes.length - 8 + index] === byte)
  ) {
    throw new Error(`${source}: invalid LevelDB table footer`);
  }
  let footerOffset = bytes.length - 48;
  footerOffset = readVarint(bytes, footerOffset, source).next;
  footerOffset = readVarint(bytes, footerOffset, source).next;
  const indexOffset = readVarint(bytes, footerOffset, source);
  footerOffset = indexOffset.next;
  const indexSize = readVarint(bytes, footerOffset, source);
  const indexBlock = readBlock(bytes, { offset: indexOffset.value, size: indexSize.value }, source);

  for (const entry of parseBlock(indexBlock, source)) {
    const handleOffset = readVarint(entry.value, 0, source);
    const handleSize = readVarint(entry.value, handleOffset.next, source);
    if (handleSize.next !== entry.value.length)
      throw new Error(`${source}: malformed LevelDB block handle`);
    const dataBlock = readBlock(
      bytes,
      { offset: handleOffset.value, size: handleSize.value },
      source,
    );
    for (const record of parseBlock(dataBlock, source)) {
      if (record.key.length < 8) throw new Error(`${source}: LevelDB internal key is too short`);
      const tag = fixed64(record.key, record.key.length - 8);
      const type = Number(tag & 0xffn);
      const sequence = tag >> 8n;
      const key = record.key.subarray(0, record.key.length - 8);
      if (type === 1) add(key, record.value, sequence, source);
      else if (type === 0) add(key, undefined, sequence, source);
      else throw new Error(`${source}: unknown LevelDB internal key type ${type}`);
    }
  }
}

function readBlock(bytes: Uint8Array, handle: BlockHandle, source: string): Uint8Array {
  if (handle.offset < 0 || handle.size < 0 || handle.offset + handle.size > bytes.length - 48) {
    throw new Error(`${source}: LevelDB block handle is outside the table`);
  }
  const raw = bytes.subarray(handle.offset, handle.offset + handle.size);
  const compression =
    handle.offset + handle.size + 5 <= bytes.length
      ? bytes[handle.offset + handle.size]
      : undefined;
  if (compression === 1) return uncompressSnappy(raw, source);
  if (compression === 0) return tryInflateBlock(raw) ?? raw;

  // Some Bedrock tooling emits deflated blocks without a standard LevelDB trailer.
  // Try both zlib wrappers, then treat the block as ordinary uncompressed bytes.
  return tryInflateBlock(raw) ?? raw;
}

function tryInflateBlock(raw: Uint8Array): Uint8Array | undefined {
  try {
    const inflated = inflateRaw(raw);
    if (looksLikeBlock(inflated)) return inflated;
  } catch {
    // Try the zlib-wrapped form below.
  }
  try {
    const inflated = inflate(raw);
    if (looksLikeBlock(inflated)) return inflated;
  } catch {
    // The block is uncompressed.
  }
  return undefined;
}

function looksLikeBlock(block: Uint8Array): boolean {
  if (block.length < 4) return false;
  const restarts = fixed32(block, block.length - 4);
  return restarts <= (block.length - 4) / 4;
}

function parseBlock(
  block: Uint8Array,
  source: string,
): Array<{ key: Uint8Array; value: Uint8Array }> {
  if (block.length < 4) throw new Error(`${source}: truncated LevelDB block`);
  const restartCount = fixed32(block, block.length - 4);
  const entriesEnd = block.length - 4 - restartCount * 4;
  if (entriesEnd < 0) throw new Error(`${source}: invalid LevelDB restart array`);

  let offset = 0;
  let previousKey = new Uint8Array();
  const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
  while (offset < entriesEnd) {
    const shared = readVarint(block, offset, source);
    const unshared = readVarint(block, shared.next, source);
    const value = readVarint(block, unshared.next, source);
    if (
      shared.value > previousKey.length ||
      value.next + unshared.value + value.value > entriesEnd
    ) {
      throw new Error(`${source}: malformed LevelDB block entry`);
    }
    const key = new Uint8Array(shared.value + unshared.value);
    key.set(previousKey.subarray(0, shared.value));
    key.set(block.subarray(value.next, value.next + unshared.value), shared.value);
    const entryValue = block.subarray(
      value.next + unshared.value,
      value.next + unshared.value + value.value,
    );
    entries.push({ key, value: entryValue });
    previousKey = key;
    offset = value.next + unshared.value + value.value;
  }
  if (offset !== entriesEnd) throw new Error(`${source}: malformed LevelDB block entries`);
  return entries;
}

function uncompressSnappy(input: Uint8Array, source: string): Uint8Array {
  const length = readVarint(input, 0, source);
  const output = new Uint8Array(length.value);
  let inputOffset = length.next;
  let outputOffset = 0;
  while (inputOffset < input.length) {
    const tag = input[inputOffset++]!;
    const type = tag & 3;
    let literalLength: number;
    if (type === 0) {
      literalLength = tag >>> 2;
      if (literalLength < 60) literalLength++;
      else {
        const extra = literalLength - 59;
        if (inputOffset + extra > input.length)
          throw new Error(`${source}: truncated Snappy literal`);
        literalLength = 1;
        for (let index = 0; index < extra; index++)
          literalLength += input[inputOffset++]! << (8 * index);
      }
      if (
        inputOffset + literalLength > input.length ||
        outputOffset + literalLength > output.length
      ) {
        throw new Error(`${source}: invalid Snappy literal`);
      }
      output.set(input.subarray(inputOffset, inputOffset + literalLength), outputOffset);
      inputOffset += literalLength;
      outputOffset += literalLength;
      continue;
    }
    let copyLength: number;
    let copyOffset: number;
    if (type === 1) {
      if (inputOffset >= input.length) throw new Error(`${source}: truncated Snappy copy`);
      copyLength = 4 + ((tag >>> 2) & 7);
      copyOffset = ((tag & 0xe0) << 3) | input[inputOffset++]!;
    } else if (type === 2) {
      if (inputOffset + 2 > input.length) throw new Error(`${source}: truncated Snappy copy`);
      copyLength = 1 + (tag >>> 2);
      copyOffset = input[inputOffset]! | (input[inputOffset + 1]! << 8);
      inputOffset += 2;
    } else {
      if (inputOffset + 4 > input.length) throw new Error(`${source}: truncated Snappy copy`);
      copyLength = 1 + (tag >>> 2);
      copyOffset = fixed32(input, inputOffset);
      inputOffset += 4;
    }
    if (
      copyOffset === 0 ||
      copyOffset > outputOffset ||
      outputOffset + copyLength > output.length
    ) {
      throw new Error(`${source}: invalid Snappy copy`);
    }
    for (let index = 0; index < copyLength; index++)
      output[outputOffset + index] = output[outputOffset - copyOffset + index]!;
    outputOffset += copyLength;
  }
  if (outputOffset !== output.length) throw new Error(`${source}: incomplete Snappy block`);
  return output;
}

function readLengthPrefixed(
  bytes: Uint8Array,
  offset: number,
  source: string,
): { value: Uint8Array; next: number } {
  const length = readVarint(bytes, offset, source);
  if (length.value > bytes.length - length.next)
    throw new Error(`${source}: truncated LevelDB length-prefixed value`);
  return {
    value: bytes.subarray(length.next, length.next + length.value),
    next: length.next + length.value,
  };
}

function readVarint(
  bytes: Uint8Array,
  offset: number,
  source: string,
): { value: number; next: number } {
  let value = 0;
  for (let shift = 0; shift <= 28; shift += 7) {
    if (offset >= bytes.length) throw new Error(`${source}: truncated LevelDB varint`);
    const byte = bytes[offset++]!;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset };
  }
  throw new Error(`${source}: LevelDB varint is too large`);
}

function fixed32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

function fixed64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]!);
  return value;
}

function join(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
