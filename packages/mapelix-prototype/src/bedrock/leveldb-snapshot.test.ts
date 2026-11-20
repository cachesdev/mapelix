import { describe, expect, it } from "vitest";
import {
  concatBytes,
  encodeText,
  fixtureBatch,
  fixtureEdit,
  fixtureLog,
  fixtureTable,
  fixtureVarint,
  internalFixtureKey,
} from "../../test/leveldb-fixture.js";
import { levelDbLogRecords } from "./leveldb-log.js";
import { readLevelDbCurrent, readLevelDbManifest, selectLevelDbFiles } from "./leveldb-snapshot.js";
import { readLevelDbRecords } from "./record-source.js";

const table = fixtureTable([{ key: encodeText("key"), value: encodeText("value"), sequence: 1n }]);
const header = fixtureEdit({
  comparator: "leveldb.BytewiseComparator",
  logNumber: 12,
  previousLogNumber: 9,
  nextFileNumber: 20,
  lastSequence: 10,
});
const read = (...edits: Uint8Array[]) =>
  readLevelDbManifest(fixtureLog([header, ...edits]), "MANIFEST-000002");

describe("LevelDB snapshot selection", () => {
  it("replays deletions, additions and level moves across edits", () => {
    const manifest = read(
      fixtureEdit({
        added: [
          { number: 3, bytes: table },
          { number: 4, bytes: table },
        ],
      }),
      fixtureEdit({
        removed: [{ number: 3, level: 0 }],
        added: [
          { number: 3, level: 1, bytes: table },
          { number: 5, bytes: table },
        ],
      }),
      fixtureEdit({ removed: [{ number: 4, level: 0 }] }),
    );
    expect(manifest.tables.map(({ number, level, size }) => ({ number, level, size }))).toEqual([
      { number: 3n, level: 1, size: table.length },
      { number: 5n, level: 0, size: table.length },
    ]);
    const selected = selectLevelDbFiles(manifest, [
      "000003.sst",
      "000005.ldb",
      "000004.ldb",
      "000008.log",
      "000009.log",
      "000012.log",
      "000100.log",
      "LOG",
      "CURRENT",
    ]);
    expect(selected.tables.map(({ name }) => name)).toEqual(["000003.sst", "000005.ldb"]);
    expect(selected.logs.map(({ name }) => name)).toEqual([
      "000009.log",
      "000012.log",
      "000100.log",
    ]);
    expect(selected.ignoredTables).toEqual(["000004.ldb"]);
  });

  it("applies an edit's additions after its deletions irrespective of tag order", () => {
    const edit = concatBytes(
      fixtureEdit({ added: [{ number: 3, bytes: table }] }),
      fixtureEdit({ removed: [{ number: 3, level: 0 }] }),
    );
    expect(read(edit).tables.map(({ number }) => number)).toEqual([3n]);
  });

  it("preserves 64-bit file numbers and does not select log zero as PrevLogNumber zero", () => {
    const number = (1n << 54n) + 1n;
    const manifest = readLevelDbManifest(
      fixtureLog([
        fixtureEdit({
          logNumber: number,
          previousLogNumber: 0,
          nextFileNumber: number + 10n,
          lastSequence: 1,
          added: [{ number, bytes: table }],
        }),
      ]),
      "manifest",
    );
    const selected = selectLevelDbFiles(manifest, [
      `${number}.ldb`,
      `${number}.log`,
      `${number - 1n}.log`,
      "000000.log",
    ]);
    expect(selected.tables[0]?.number).toBe(number);
    expect(selected.logs.map(({ number }) => number)).toEqual([number]);
  });

  it("prefers .ldb to the legacy .sst name for the same table", () => {
    const selected = selectLevelDbFiles(
      read(fixtureEdit({ added: [{ number: 3, bytes: table }] })),
      ["000003.sst", "000003.ldb"],
    );
    expect(selected.tables[0]?.name).toBe("000003.ldb");
    expect(selected.ignoredTables).toEqual(["000003.sst"]);
  });

  it("rejects missing active tables and never substitutes an inactive file", () => {
    expect(() =>
      selectLevelDbFiles(read(fixtureEdit({ added: [{ number: 3, bytes: table }] })), [
        "000004.ldb",
      ]),
    ).toThrowError(expect.objectContaining({ code: "ACTIVE_FILE_MISSING", file: "000003.ldb" }));
  });

  it.each([
    "",
    "MANIFEST-000002",
    "../MANIFEST-000002\n",
    "MANIFEST-000002\r\n",
    "MANIFEST-000002\nextra",
    "/MANIFEST-000002\n",
  ])("rejects invalid CURRENT %j", (text) => {
    expect(() => readLevelDbCurrent(encodeText(text))).toThrowError(
      expect.objectContaining({ code: "CURRENT_INVALID" }),
    );
  });

  it("accepts only the manifest designated by CURRENT", () => {
    expect(readLevelDbCurrent(encodeText("MANIFEST-038301\n"))).toBe("MANIFEST-038301");
  });

  it.each([
    fixtureEdit({ comparator: "other.Comparator" }),
    new Uint8Array([8]),
    new Uint8Array([100]),
  ])("rejects unsupported comparators and VersionEdit tags", (edit) => {
    expect(() => read(edit)).toThrowError(
      expect.objectContaining({ code: "MANIFEST_UNSUPPORTED" }),
    );
  });

  it.each([
    new Uint8Array([2, 128]),
    new Uint8Array([7, 7]),
    new Uint8Array([1, 8, 65]),
    concatBytes(new Uint8Array([4]), fixtureVarint(1n << 56n)),
  ])("rejects malformed VersionEdits", (edit) => {
    expect(() => read(edit)).toThrowError(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it("requires recovery metadata and unique active table levels", () => {
    expect(() =>
      readLevelDbManifest(fixtureLog([fixtureEdit({ logNumber: 1 })]), "manifest"),
    ).toThrowError(expect.objectContaining({ code: "MANIFEST_INVALID" }));
    expect(() =>
      read(
        fixtureEdit({
          added: [
            { number: 3, bytes: table },
            { number: 3, level: 1, bytes: table },
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it("rejects reversed table bounds even with valid manifest checksums", () => {
    const smallest = internalFixtureKey({
      key: encodeText("z"),
      value: new Uint8Array(),
      sequence: 1n,
    });
    const largest = internalFixtureKey({
      key: encodeText("a"),
      value: new Uint8Array(),
      sequence: 1n,
    });
    expect(() =>
      read(fixtureEdit({ added: [{ number: 3, bytes: table, smallest, largest }] })),
    ).toThrowError(expect.objectContaining({ code: "MANIFEST_INVALID" }));
  });

  it("rejects a damaged manifest CRC", () => {
    const bytes = fixtureLog([header]);
    bytes[0]! ^= 1;
    expect(() => readLevelDbManifest(bytes, "manifest")).toThrowError(
      expect.objectContaining({
        code: "MANIFEST_INVALID",
        message: expect.stringContaining("checksum"),
      }),
    );
  });
});

describe("LevelDB physical log integrity", () => {
  it("reassembles fragmented records across blocks, including an empty FIRST fragment", () => {
    const records = [
      new Uint8Array(32754).fill(1),
      new Uint8Array(80000).fill(2),
      new Uint8Array([3]),
    ];
    expect([...levelDbLogRecords(fixtureLog(records), "log")]).toEqual(records);
  });

  it.each([1, 3, 8])("rejects a log shortened by %i bytes", (cut) => {
    const bytes = fixtureLog([new Uint8Array(70000).fill(1)]);
    expect(() => [...levelDbLogRecords(bytes.subarray(0, bytes.length - cut), "log")]).toThrow();
  });

  it("rejects a corrupted continuation CRC and an unfinished fragmented record", () => {
    const bytes = fixtureLog([new Uint8Array(70000).fill(1)]);
    const corrupt = bytes.slice();
    corrupt[32768]! ^= 1;
    expect(() => [...levelDbLogRecords(corrupt, "log")]).toThrow(/checksum/);
    expect(() => [...levelDbLogRecords(bytes.subarray(0, 32768), "log")]).toThrow(/incomplete/);
  });

  it("replays recent writes and tombstones without capping them at manifest LastSequence", () => {
    const files = [
      {
        name: "000012.log",
        bytes: fixtureLog([
          fixtureBatch(20n, [
            { key: encodeText("a"), value: encodeText("old") },
            { key: encodeText("b"), value: encodeText("gone") },
          ]),
          fixtureBatch(30n, [
            { key: encodeText("a"), value: encodeText("new") },
            { key: encodeText("b") },
          ]),
        ]),
      },
    ];
    const records = readLevelDbRecords(files, { verifyChecksums: true });
    expect(
      records.map(({ key, value, sequence }) => [
        new TextDecoder().decode(key),
        new TextDecoder().decode(value),
        sequence,
      ]),
    ).toEqual([["a", "new", 30n]]);
  });

  it("checks WAL CRCs and 56-bit write sequence overflow", () => {
    const bytes = fixtureLog([fixtureBatch(10n, [{ key: encodeText("a") }])]);
    bytes[0]! ^= 1;
    expect(() =>
      readLevelDbRecords([{ name: "000012.log", bytes }], { verifyChecksums: true }),
    ).toThrow(/checksum/);
    expect(() =>
      readLevelDbRecords([
        {
          name: "000012.log",
          bytes: fixtureLog([
            fixtureBatch((1n << 56n) - 1n, [{ key: encodeText("a") }, { key: encodeText("b") }]),
          ]),
        },
      ]),
    ).toThrow(/sequence/);
  });
});
