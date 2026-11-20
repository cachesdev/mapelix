import { describe, expect, it } from "vitest";
import {
  encodeText,
  fixtureChecksum,
  fixtureTableMetadata,
  fixtureVarint,
  internalFixtureKey,
  type FixtureTableMetadata,
} from "../../test/leveldb-fixture.js";
import {
  LevelDbBlockLimitError,
  readBlockHandle,
  readSnappyBlock,
  readTableBlock,
  readTableFooterHandles,
  parseTableBlock,
  type BlockHandle,
} from "./record-source.js";
import { validateLevelDbTable } from "./table-validation.js";

const versions = [
  { key: encodeText("a"), value: encodeText("old"), sequence: 2n },
  { key: encodeText("a"), sequence: 4n },
  { key: encodeText("b"), value: encodeText("current"), sequence: 5n },
];
const filter = new Uint8Array([1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 11]);
function validate(table: FixtureTableMetadata) {
  return [
    ...validateLevelDbTable(
      table.bytes,
      {
        number: BigInt(table.number),
        level: table.level ?? 0,
        size: table.bytes.length,
        smallest: table.smallest!,
        largest: table.largest!,
      },
      "table",
      (bytes, source) => readTableBlock(bytes, source, true),
    ),
  ];
}
function mutate(
  table: FixtureTableMetadata,
  handle: BlockHandle,
  change: (bytes: Uint8Array) => void,
): FixtureTableMetadata {
  const bytes = table.bytes.slice();
  change(bytes.subarray(handle.offset, handle.offset + handle.size));
  new DataView(bytes.buffer).setUint32(
    handle.offset + handle.size + 1,
    fixtureChecksum(bytes.subarray(handle.offset, handle.offset + handle.size + 1)),
    true,
  );
  return { ...table, bytes };
}
function handles(table: FixtureTableMetadata) {
  return readTableFooterHandles(table.bytes.subarray(table.bytes.length - 48), "table");
}

describe("exhaustive portable table validation", () => {
  it.each(["none", "snappy", "zlib", "raw"] as const)(
    "checks every data and metadata block with %s compression",
    (compression) => {
      const table = fixtureTableMetadata(3, versions, { blockRecordCount: 1, filter, compression });
      expect(validate(table)).toHaveLength(6);
    },
  );

  it.each(["metadata", "filter", "late-data"])(
    "detects corruption in an otherwise unread %s block",
    (kind) => {
      const table = fixtureTableMetadata(3, versions, { blockRecordCount: 1, filter });
      const footer = handles(table);
      let handle = footer.metaindex;
      const entries = (block: BlockHandle) =>
        parseTableBlock(
          readTableBlock(
            table.bytes.subarray(block.offset, block.offset + block.size + 5),
            "table",
            true,
          ),
          "table",
        );
      if (kind === "filter") handle = readBlockHandle(entries(footer.metaindex)[0]!.value, "table");
      if (kind === "late-data") handle = readBlockHandle(entries(footer.index)[2]!.value, "table");
      const bytes = table.bytes.slice();
      bytes[handle.offset]! ^= 1;
      expect(() => validate({ ...table, bytes })).toThrow(/checksum/);
    },
  );

  it("rejects malformed restart offsets despite a valid CRC", () => {
    const table = fixtureTableMetadata(3, versions);
    const bad = mutate(table, handles(table).index, (bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
        bytes.length - 8,
        1,
        true,
      ),
    );
    expect(() => validate(bad)).toThrow(/restart/);
  });

  it("rejects bad key ordering and inaccurate manifest bounds", () => {
    const table = fixtureTableMetadata(3, versions);
    const index = handles(table).index;
    const data = readBlockHandle(
      parseTableBlock(
        readTableBlock(
          table.bytes.subarray(index.offset, index.offset + index.size + 5),
          "table",
          true,
        ),
        "table",
      )[0]!.value,
      "table",
    );
    expect(() =>
      validate(
        mutate(table, data, (bytes) => {
          bytes[3] = 122;
        }),
      ),
    ).toThrow(/order/);
    expect(() =>
      validate({
        ...table,
        smallest: internalFixtureKey({
          key: encodeText("0"),
          value: new Uint8Array(),
          sequence: 1n,
        }),
      }),
    ).toThrow(/bounds/);
  });

  it("rejects unknown table metadata and invalid filter offsets with valid CRCs", () => {
    const table = fixtureTableMetadata(3, versions, { filter });
    const footer = handles(table);
    expect(() =>
      validate(
        mutate(table, footer.metaindex, (bytes) => {
          bytes[3] = 120;
        }),
      ),
    ).toThrow(/unsupported table metadata/);
    const entries = parseTableBlock(
      readTableBlock(
        table.bytes.subarray(
          footer.metaindex.offset,
          footer.metaindex.offset + footer.metaindex.size + 5,
        ),
        "table",
        true,
      ),
      "table",
    );
    const handle = readBlockHandle(entries[0]!.value, "table");
    expect(() =>
      validate(
        mutate(table, handle, (bytes) =>
          new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(
            bytes.length - 5,
            999,
            true,
          ),
        ),
      ),
    ).toThrow(/filter/);
  });

  it("checks reserved footer padding", () => {
    const table = fixtureTableMetadata(3, versions);
    const bytes = table.bytes.slice();
    bytes[bytes.length - 9] = 1;
    expect(() => validate({ ...table, bytes })).toThrow(/padding/);
  });

  it("bounds Snappy allocation before creating an oversized output", () => {
    expect(() =>
      readSnappyBlock(new Uint8Array([...fixtureVarint(1 << 28), 0]), "block", 1024),
    ).toThrow(LevelDbBlockLimitError);
  });
});
