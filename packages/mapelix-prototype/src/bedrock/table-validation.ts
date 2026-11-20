import type { LevelDbTableMetadata } from "./leveldb-snapshot.js";
import {
  TABLE_BLOCK_TRAILER_SIZE,
  TABLE_FOOTER_SIZE,
  parseInternalKey,
  parseTableBlock,
  readBlockHandle,
  readTableFooterHandles,
  type BlockHandle,
} from "./record-source.js";

/** A caller supplies decompression and resource limits; this module never accesses files. */
export type ValidationBlockDecoder = (
  encoded: Uint8Array,
  source: string,
  filter: boolean,
) => Uint8Array;

/** Internal keys sort by user bytes, then by descending sequence/type. */
export function compareInternalKeys(left: Uint8Array, right: Uint8Array): number {
  const a = parseInternalKey(left, "table key");
  const b = parseInternalKey(right, "table key");
  return (
    compareBytes(a.key, b.key) ||
    (a.sequence > b.sequence ? -1 : a.sequence < b.sequence ? 1 : 0) ||
    Number(a.deleted) - Number(b.deleted)
  );
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Visits all referenced blocks, yielding between blocks for caller cancellation. */
export function* validateLevelDbTable(
  bytes: Uint8Array,
  metadata: LevelDbTableMetadata,
  source: string,
  decode: ValidationBlockDecoder,
): Generator<void> {
  const fail = (message: string): never => {
    throw new Error(`${source}: ${message}`);
  };
  if (bytes.length !== metadata.size || bytes.length < TABLE_FOOTER_SIZE)
    fail("invalid logical table length");
  const footer = readTableFooterHandles(
    bytes.subarray(bytes.length - TABLE_FOOTER_SIZE),
    source,
    true,
  );
  const ranges = new Map<number, number>();
  const block = (handle: BlockHandle, filter = false): Uint8Array => {
    const end = handle.offset + handle.size + TABLE_BLOCK_TRAILER_SIZE;
    if (
      !Number.isSafeInteger(end) ||
      handle.offset < 0 ||
      handle.size < 0 ||
      end > bytes.length - TABLE_FOOTER_SIZE
    )
      fail("block handle is outside the logical table");
    if (ranges.has(handle.offset)) fail("duplicate table block handle");
    ranges.set(handle.offset, end);
    return decode(bytes.subarray(handle.offset, end), source, filter);
  };
  const index = parseTableBlock(block(footer.index), source, true);
  if (index.length === 0) fail("active table has no data blocks");
  for (let position = 0; position < index.length; position++) {
    parseInternalKey(index[position]!.key, source);
    if (position > 0 && compareInternalKeys(index[position - 1]!.key, index[position]!.key) >= 0)
      fail("index keys are not strictly ordered");
  }
  yield;
  const metaindex = parseTableBlock(block(footer.metaindex), source, true);
  yield;
  for (let position = 0; position < metaindex.length; position++) {
    const entry = metaindex[position]!;
    if (position > 0 && compareBytes(metaindex[position - 1]!.key, entry.key) >= 0)
      fail("metadata keys are not strictly ordered");
    const name = new TextDecoder().decode(entry.key);
    if (!name.startsWith("filter.")) fail(`unsupported table metadata ${name}`);
    const filter = block(readBlockHandle(entry.value, source), true);
    if (filter.length < 5) fail("truncated filter block");
    const view = new DataView(filter.buffer, filter.byteOffset, filter.byteLength);
    const arrayOffset = view.getUint32(filter.length - 5, true);
    if (
      arrayOffset > filter.length - 5 ||
      (filter.length - 5 - arrayOffset) % 4 !== 0 ||
      filter[filter.length - 1]! > 63
    )
      fail("invalid filter offset array");
    let previous = 0;
    for (let offset = arrayOffset; offset < filter.length - 5; offset += 4) {
      const value = view.getUint32(offset, true);
      if (value < previous || value > arrayOffset || (offset === arrayOffset && value !== 0))
        fail("invalid filter offset");
      previous = value;
    }
    yield;
  }
  let first: Uint8Array | undefined;
  let last: Uint8Array | undefined;
  let separator: Uint8Array | undefined;
  for (const entry of index) {
    const records = parseTableBlock(block(readBlockHandle(entry.value, source)), source, true);
    if (records.length === 0) fail("empty indexed data block");
    if (separator !== undefined && compareInternalKeys(separator, records[0]!.key) >= 0)
      fail("index separator overlaps the following data block");
    for (const record of records) {
      const internal = parseInternalKey(record.key, source);
      if (internal.deleted && record.value.length !== 0) fail("table tombstone contains a value");
      if (last !== undefined && compareInternalKeys(last, record.key) >= 0)
        fail("data keys are not strictly ordered");
      first ??= record.key;
      last = record.key;
    }
    if (compareInternalKeys(last!, entry.key) > 0) fail("index separator precedes its data block");
    separator = entry.key;
    yield;
  }
  if (
    first === undefined ||
    last === undefined ||
    compareBytes(first, metadata.smallest) !== 0 ||
    compareBytes(last, metadata.largest) !== 0
  )
    fail("table key bounds disagree with the manifest");
  let previousEnd = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (start < previousEnd) fail("overlapping table blocks");
    previousEnd = end;
  }
}
