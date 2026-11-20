import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBedrockWorld } from "@mapelix/prototype";
import { openLevelDbSnapshot, readLevelDbSnapshotFile } from "@mapelix/prototype/node/leveldb";
import {
  encodeText,
  fixtureBatch,
  fixtureEdit,
  fixtureLog,
  fixtureTable,
  writeFixtureManifest,
} from "../../../mapelix-prototype/test/leveldb-fixture.js";
import { sectionRecord } from "../../test/dimension-fixture.js";
import { RegionBuilder } from "../node/region-builder.js";
import { WorldDatabase } from "./world-database.js";

let directory: string;
let table: Uint8Array;
const section = (x: number, name: string) => sectionRecord(0, x, 0, 4, name);
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mapelix-snapshot-"));
  table = fixtureTable([
    { ...section(0, "minecraft:gold_block"), sequence: 1n },
    { ...section(1, "minecraft:stone"), sequence: 2n },
    { ...section(3, "minecraft:coal_block"), sequence: 3n },
  ]);
  await writeFixtureManifest(directory, [
    fixtureEdit({
      logNumber: 12,
      previousLogNumber: 9,
      nextFileNumber: 14,
      lastSequence: 3,
      added: [{ number: 3, bytes: table }],
    }),
  ]);
  for (const [name, bytes] of [
    ["000003.ldb", table],
    ["000008.log", encodeText("obsolete broken WAL")],
    ["000009.log", fixtureLog([fixtureBatch(15n, [section(3, "minecraft:blue_wool")])])],
    [
      "000012.log",
      fixtureLog([
        fixtureBatch(20n, [
          section(0, "minecraft:diamond_block"),
          { key: section(1, "minecraft:air").key },
        ]),
      ]),
    ],
    ["000013.log", fixtureLog([fixtureBatch(30n, [section(2, "minecraft:red_wool")])])],
  ] as const)
    await writeFile(join(directory, "db", name), bytes);
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function renderState() {
  const world = await openBedrockWorld({ directory, chunkFingerprints: true });
  const database = WorldDatabase.open(directory);
  const builder = new RegionBuilder({ directory, dimension: "overworld" });
  try {
    const tile = await world.renderTile(
      { dimension: "overworld", z: 0, x: 0, y: 0 },
      { shadows: false },
    );
    return {
      tile: sha256(tile.rgba),
      region: sha256(builder.build({ level: 0, x: 0, z: 0 })),
      chunks: [...world.getChunkFingerprints!("overworld").keys()].sort(),
      records: [0, 1, 2, 3].map((x) =>
        database
          .readPrefix(section(x, "minecraft:air").key.subarray(0, 8))
          .map(({ key, value }) => [sha256(key), sha256(value)]),
      ),
    };
  } finally {
    await world.close();
    database.close();
    builder.close();
  }
}

async function expectBothFail(code: string) {
  await expect(openBedrockWorld({ directory })).rejects.toMatchObject({ code });
  expect(() => WorldDatabase.open(directory)).toThrowError(expect.objectContaining({ code }));
}

describe("manifest-selected 2D and 3D snapshots", () => {
  it("ignores a 79,383-byte inactive unfinished table and inactive conflicting values", async () => {
    const baseline = await renderState();
    const unfinished = new Uint8Array(79383).fill(3);
    unfinished.set([0xd5, 0xff, 0x03, 0x04, 0x42, 0x4f, 0x9f, 0x9f], unfinished.length - 8);
    await writeFile(join(directory, "db", "038514.ldb"), unfinished);
    await writeFile(
      join(directory, "db", "000004.ldb"),
      fixtureTable([{ ...section(0, "minecraft:air"), sequence: 1000n }]),
    );
    expect(openLevelDbSnapshot(directory).ignoredTables).toEqual(["000004.ldb", "038514.ldb"]);
    expect(await renderState()).toEqual(baseline);
    expect(baseline.chunks).toEqual(["0,0", "2,0", "3,0"]);
    expect(baseline.records[1]).toEqual([]);
    expect(baseline.records[0]?.[0]?.[1]).toBe(sha256(section(0, "minecraft:diamond_block").value));
    expect(baseline.records[2]?.[0]?.[1]).toBe(sha256(section(2, "minecraft:red_wool").value));
    expect(baseline.records[3]?.[0]?.[1]).toBe(sha256(section(3, "minecraft:blue_wool").value));
  });

  it("rejects the unfinished table when the manifest makes it active", async () => {
    const unfinished = new Uint8Array(79383).fill(3);
    await writeFile(join(directory, "db", "038514.ldb"), unfinished);
    await writeFixtureManifest(directory, [
      fixtureEdit({
        logNumber: 12,
        nextFileNumber: 38515,
        lastSequence: 3,
        added: [{ number: 38514, bytes: unfinished }],
      }),
    ]);
    await expectBothFail("ACTIVE_TABLE_INVALID");
  });

  it.each(["missing", "short", "footer", "checksum"])(
    "rejects an active table that is %s",
    async (fault) => {
      const path = join(directory, "db", "000003.ldb");
      if (fault === "missing") await rm(path);
      else {
        const bytes = table.slice();
        if (fault === "footer") bytes[bytes.length - 1]! ^= 1;
        if (fault === "checksum") bytes[0]! ^= 1;
        await writeFile(path, fault === "short" ? bytes.subarray(0, bytes.length - 1) : bytes);
      }
      await expectBothFail(fault === "missing" ? "ACTIVE_FILE_MISSING" : "ACTIVE_TABLE_INVALID");
    },
  );

  it("uses manifest logical lengths even when the physical table has extra bytes", async () => {
    const baseline = await renderState();
    await appendFile(join(directory, "db", "000003.ldb"), new Uint8Array(100).fill(255));
    expect(await renderState()).toEqual(baseline);
    const snapshot = openLevelDbSnapshot(directory);
    expect(await readLevelDbSnapshotFile(join(directory, "db"), snapshot.files[0]!)).toEqual(table);
  });

  it("rejects insufficient reads after selection", async () => {
    const file = openLevelDbSnapshot(directory).files[0]!;
    await writeFile(join(directory, "db", file.name), table.subarray(0, 20));
    await expect(readLevelDbSnapshotFile(join(directory, "db"), file)).rejects.toMatchObject({
      code: "ACTIVE_TABLE_INVALID",
    });
  });

  it.each(["000009.log", "000012.log", "000013.log"])(
    "verifies required journal %s",
    async (name) => {
      const bytes = await readFile(join(directory, "db", name));
      bytes[0]! ^= 1;
      await writeFile(join(directory, "db", name), bytes);
      await expectBothFail("REQUIRED_LOG_INVALID");
    },
  );

  it.each(["current", "manifest", "crc", "unsupported"])(
    "rejects %s without a directory-scan fallback",
    async (fault) => {
      if (fault === "current") await rm(join(directory, "db", "CURRENT"));
      if (fault === "manifest") await rm(join(directory, "db", "MANIFEST-000002"));
      if (fault === "crc") {
        const path = join(directory, "db", "MANIFEST-000002");
        const bytes = await readFile(path);
        bytes[0]! ^= 1;
        await writeFile(path, bytes);
      }
      if (fault === "unsupported") await writeFixtureManifest(directory, [new Uint8Array([100])]);
      await expectBothFail(
        fault === "current"
          ? "CURRENT_INVALID"
          : fault === "unsupported"
            ? "MANIFEST_UNSUPPORTED"
            : "MANIFEST_INVALID",
      );
    },
  );

  it("leaves input contents, file inventory, modification times and modes unchanged", async () => {
    async function inventory() {
      return Promise.all(
        (await readdir(join(directory, "db"))).sort().map(async (name) => {
          const path = join(directory, "db", name);
          const details = await stat(path);
          return {
            name,
            hash: sha256(await readFile(path)),
            mode: details.mode,
            mtime: details.mtimeMs,
            ctime: details.ctimeMs,
          };
        }),
      );
    }
    const before = await inventory();
    await renderState();
    expect(await inventory()).toEqual(before);
  });
});
