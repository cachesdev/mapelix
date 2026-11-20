import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const encodeText = (text: string): Uint8Array => new TextEncoder().encode(text);
export const concatBytes = (...parts: Uint8Array[]): Uint8Array =>
  new Uint8Array(Buffer.concat(parts));

export function fixtureVarint(input: number | bigint): Uint8Array {
  let value = BigInt(input);
  const bytes: number[] = [];
  do {
    bytes.push(Number(value & 127n) | (value >= 128n ? 128 : 0));
    value >>= 7n;
  } while (value > 0n);
  return new Uint8Array(bytes);
}

function fixed32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function fixed64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

/** Independent bitwise encoder, deliberately separate from the production CRC implementation. */
export function fixtureChecksum(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0x82f63b78 : 0);
  }
  value = ~value;
  return (((value >>> 15) | (value << 17)) + 0xa282ead8) >>> 0;
}

export function fixtureLog(records: readonly Uint8Array[]): Uint8Array {
  const frames: Uint8Array[] = [];
  let position = 0;
  for (const record of records) {
    let offset = 0;
    let first = true;
    do {
      let remaining = 32768 - (position % 32768);
      if (remaining < 7) {
        frames.push(new Uint8Array(remaining));
        position += remaining;
        remaining = 32768;
      }
      const length = Math.min(remaining - 7, record.length - offset);
      const last = offset + length === record.length;
      const type = first ? (last ? 1 : 2) : last ? 4 : 3;
      const frame = new Uint8Array(7 + length);
      frame[6] = type;
      frame.set(record.subarray(offset, offset + length), 7);
      const view = new DataView(frame.buffer);
      view.setUint16(4, length, true);
      view.setUint32(0, fixtureChecksum(frame.subarray(6)), true);
      frames.push(frame);
      position += frame.length;
      offset += length;
      first = false;
    } while (offset < record.length);
  }
  return concatBytes(...frames);
}

export interface FixtureVersion {
  readonly key: Uint8Array;
  readonly value?: Uint8Array;
  readonly sequence: bigint;
}

export function fixtureBatch(
  sequence: bigint,
  entries: readonly Omit<FixtureVersion, "sequence">[],
): Uint8Array {
  return concatBytes(
    fixed64(sequence),
    fixed32(entries.length),
    ...entries.map((entry) =>
      concatBytes(
        new Uint8Array([entry.value === undefined ? 0 : 1]),
        prefixed(entry.key),
        ...(entry.value === undefined ? [] : [prefixed(entry.value)]),
      ),
    ),
  );
}

function prefixed(bytes: Uint8Array): Uint8Array {
  return concatBytes(fixtureVarint(bytes.length), bytes);
}
export function internalFixtureKey(record: FixtureVersion): Uint8Array {
  return concatBytes(
    record.key,
    fixed64((record.sequence << 8n) | (record.value === undefined ? 0n : 1n)),
  );
}

function block(entries: readonly { key: Uint8Array; value: Uint8Array }[]): Uint8Array {
  return concatBytes(
    ...entries.map(({ key, value }) =>
      concatBytes(
        new Uint8Array([0]),
        fixtureVarint(key.length),
        fixtureVarint(value.length),
        key,
        value,
      ),
    ),
    fixed32(0),
    fixed32(1),
  );
}

function tableBlock(bytes: Uint8Array): Uint8Array {
  const encoded = concatBytes(bytes, new Uint8Array([0]));
  return concatBytes(encoded, fixed32(fixtureChecksum(encoded)));
}

export function fixtureTable(records: readonly FixtureVersion[]): Uint8Array {
  const sorted = [...records].sort(
    (a, b) => Buffer.compare(a.key, b.key) || (a.sequence > b.sequence ? -1 : 1),
  );
  const dataBytes = block(
    sorted.map((record) => ({
      key: internalFixtureKey(record),
      value: record.value ?? new Uint8Array(),
    })),
  );
  const data = tableBlock(dataBytes);
  const metadataBytes = block([]);
  const metadata = tableBlock(metadataBytes);
  const indexBytes = block(
    sorted.length === 0
      ? []
      : [
          {
            key: internalFixtureKey(sorted[sorted.length - 1]!),
            value: concatBytes(fixtureVarint(0), fixtureVarint(dataBytes.length)),
          },
        ],
  );
  const footer = new Uint8Array(48);
  footer.set(
    concatBytes(
      fixtureVarint(data.length),
      fixtureVarint(metadataBytes.length),
      fixtureVarint(data.length + metadata.length),
      fixtureVarint(indexBytes.length),
    ),
  );
  footer.set([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb], 40);
  return concatBytes(data, metadata, tableBlock(indexBytes), footer);
}

export interface FixtureTableMetadata {
  readonly number: number | bigint;
  readonly level?: number;
  readonly bytes: Uint8Array;
  readonly smallest?: Uint8Array;
  readonly largest?: Uint8Array;
}

export function fixtureEdit(input: {
  readonly logNumber?: number | bigint;
  readonly previousLogNumber?: number | bigint;
  readonly nextFileNumber?: number | bigint;
  readonly lastSequence?: number | bigint;
  readonly comparator?: string;
  readonly added?: readonly FixtureTableMetadata[];
  readonly removed?: readonly { level: number; number: number | bigint }[];
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (input.comparator !== undefined)
    parts.push(new Uint8Array([1]), prefixed(encodeText(input.comparator)));
  for (const [tag, value] of [
    [2, input.logNumber],
    [3, input.nextFileNumber],
    [4, input.lastSequence],
    [9, input.previousLogNumber],
  ] as const)
    if (value !== undefined) parts.push(new Uint8Array([tag]), fixtureVarint(value));
  for (const table of input.removed ?? [])
    parts.push(new Uint8Array([6]), fixtureVarint(table.level), fixtureVarint(table.number));
  for (const table of input.added ?? []) {
    const fallbackKey = internalFixtureKey({
      key: encodeText("key"),
      value: encodeText("value"),
      sequence: 1n,
    });
    parts.push(
      new Uint8Array([7]),
      fixtureVarint(table.level ?? 0),
      fixtureVarint(table.number),
      fixtureVarint(table.bytes.length),
      prefixed(table.smallest ?? fallbackKey),
      prefixed(table.largest ?? fallbackKey),
    );
  }
  return concatBytes(...parts);
}

export async function writeFixtureManifest(
  directory: string,
  edits = [fixtureEdit({ logNumber: 1, nextFileNumber: 3, lastSequence: 0 })],
): Promise<void> {
  await mkdir(join(directory, "db"), { recursive: true });
  await writeFile(join(directory, "db", "CURRENT"), "MANIFEST-000002\n");
  await writeFile(join(directory, "db", "MANIFEST-000002"), fixtureLog(edits));
}
