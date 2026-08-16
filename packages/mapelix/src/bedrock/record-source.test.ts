import { deflateRaw } from "pako";
import { describe, expect, it } from "vitest";

import { readLevelDbRecords } from "./record-source.js";

function varint(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  bytes.push(value);
  return bytes;
}

function fixed32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function fixed64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

function bytes(value: string): number[] {
  return Array.from(new TextEncoder().encode(value));
}

function block(entries: Array<{ key: number[]; value: number[] }>): Uint8Array {
  return new Uint8Array([
    ...entries.flatMap((entry) => [
      0,
      ...varint(entry.key.length),
      ...varint(entry.value.length),
      ...entry.key,
      ...entry.value,
    ]),
    ...fixed32(0),
    ...fixed32(1),
  ]);
}

function internalRecord(
  key: string,
  value: number[],
  sequence: bigint,
  type = 1,
): { key: number[]; value: number[] } {
  return { key: [...bytes(key), ...fixed64((sequence << 8n) | BigInt(type))], value };
}

function snappyLiteral(value: Uint8Array): Uint8Array {
  const literal = value.length - 1;
  const encodedLength: number[] = [];
  if (literal >= 60) {
    let remaining = literal;
    while (remaining > 0) {
      encodedLength.push(remaining & 0xff);
      remaining >>>= 8;
    }
  }
  const tag = literal < 60 ? literal << 2 : (59 + encodedLength.length) << 2;
  return new Uint8Array([...varint(value.length), tag, ...encodedLength, ...value]);
}

function table(
  records: Array<{ key: number[]; value: number[] }>,
  compression: "none" | "snappy" | "raw-zlib" = "none",
): Uint8Array {
  const rawData = block(records);
  const encodedData =
    compression === "snappy"
      ? snappyLiteral(rawData)
      : compression === "raw-zlib"
        ? deflateRaw(rawData)
        : rawData;
  const dataTrailer =
    compression === "snappy" ? [1, 0, 0, 0, 0] : compression === "none" ? [0, 0, 0, 0, 0] : [];
  const meta = block([]);
  const indexOffset = encodedData.length + dataTrailer.length + meta.length + 5;
  const index = block([
    {
      key: [...bytes("last"), ...fixed64(1n)],
      value: [...varint(0), ...varint(encodedData.length)],
    },
  ]);
  const indexTrailer = [0, 0, 0, 0, 0];
  const footer = new Uint8Array(48);
  footer.set([
    ...varint(encodedData.length + dataTrailer.length),
    ...varint(meta.length),
    ...varint(indexOffset),
    ...varint(index.length),
  ]);
  footer.set([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb], 40);
  return new Uint8Array([
    ...encodedData,
    ...dataTrailer,
    ...meta,
    0,
    0,
    0,
    0,
    0,
    ...index,
    ...indexTrailer,
    ...footer,
  ]);
}

function log(sequence: bigint, entries: Array<{ key: string; value?: number[] }>): Uint8Array {
  const batch = [
    ...fixed64(sequence),
    ...fixed32(entries.length),
    ...entries.flatMap((entry) =>
      entry.value === undefined
        ? [0, ...varint(bytes(entry.key).length), ...bytes(entry.key)]
        : [
            1,
            ...varint(bytes(entry.key).length),
            ...bytes(entry.key),
            ...varint(entry.value.length),
            ...entry.value,
          ],
    ),
  ];
  return new Uint8Array([0, 0, 0, 0, batch.length & 0xff, batch.length >>> 8, 1, ...batch]);
}

describe("readLevelDbRecords", () => {
  it("returns effective records by sequence and applies WAL tombstones", () => {
    const records = readLevelDbRecords([
      {
        name: "000004.ldb",
        bytes: table([
          internalRecord("old", [1], 2n),
          internalRecord("gone", [2], 8n),
          internalRecord("table-gone", [4], 4n),
          internalRecord("table-gone", [], 6n, 0),
        ]),
      },
      {
        name: "000005.log",
        bytes: log(10n, [{ key: "old", value: [3] }, { key: "gone" }, { key: "empty", value: [] }]),
      },
    ]);

    expect(records.map((record) => new TextDecoder().decode(record.key))).toEqual(["old", "empty"]);
    expect(records.map((record) => Array.from(record.value))).toEqual([[3], []]);
    expect(records.map((record) => record.sequence)).toEqual([10n, 12n]);
  });

  it("reads standard Snappy blocks and legacy raw-deflate blocks without filesystem access", () => {
    const records = readLevelDbRecords([
      { name: "000010.ldb", bytes: table([internalRecord("snappy", [7], 4n)], "snappy") },
      { name: "000011.ldb", bytes: table([internalRecord("deflate", [9], 5n)], "raw-zlib") },
      { name: "CURRENT", bytes: new Uint8Array([0]) },
    ]);

    expect(
      records.map((record) => [new TextDecoder().decode(record.key), Array.from(record.value)]),
    ).toEqual([
      ["snappy", [7]],
      ["deflate", [9]],
    ]);
  });
});
