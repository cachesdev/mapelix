import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseTableBlock,
  readBlockHandle,
  readTableBlock,
  readTableFooterHandles,
} from "@mapelix/prototype/bedrock";
import {
  fixtureBatch,
  fixtureEdit,
  fixtureLog,
  fixtureTableMetadata,
  writeFixtureManifest,
  internalFixtureKey,
  encodeText,
  type FixtureTableMetadata,
} from "../../../mapelix-prototype/test/leveldb-fixture.js";
import { sectionRecord } from "../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { validateSnapshot, SNAPSHOT_VALIDATION_VERSION } from "../../dist/node/snapshot.js";
import { sha256, sourceIdentity } from "./snapshot-identity.js";

const run = promisify(execFile);
const apiEntry = fileURLToPath(new URL("../../dist/node/snapshot.js", import.meta.url));
const probe = fileURLToPath(new URL("../../test/snapshot-process.mjs", import.meta.url));
let root: string;
let table: FixtureTableMetadata;
const section = (x: number, block: string) => sectionRecord(0, x, 0, 4, block);
async function setManifest(metadata = table) {
  await writeFixtureManifest(root, [
    fixtureEdit({
      logNumber: 12,
      previousLogNumber: 9,
      nextFileNumber: 14,
      lastSequence: 2,
      added: [metadata],
    }),
  ]);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-validator-"));
  table = fixtureTableMetadata(
    3,
    [
      { ...section(0, "minecraft:stone"), sequence: 1n },
      { ...section(1, "minecraft:gold_block"), sequence: 2n },
    ],
    { blockRecordCount: 1, filter: new Uint8Array([1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 11]) },
  );
  await setManifest();
  for (const [name, bytes] of [
    ["000003.ldb", table.bytes],
    ["000009.log", fixtureLog([fixtureBatch(10n, [section(0, "minecraft:blue_wool")])])],
    [
      "000012.log",
      fixtureLog([
        fixtureBatch(30n, [
          section(0, "minecraft:red_wool"),
          { key: section(1, "minecraft:air").key },
        ]),
      ]),
    ],
    ["000013.log", fixtureLog([fixtureBatch(40n, [section(2, "minecraft:diamond_block")])])],
  ] as const)
    await writeFile(join(root, "db", name), bytes);
});
afterEach(async () => {
  await chmod(root, 0o755);
  await chmod(join(root, "db"), 0o755);
  for (const name of await readdir(join(root, "db"))) await chmod(join(root, "db", name), 0o644);
  await rm(root, { recursive: true, force: true });
});

describe("validateSnapshot contract version 1", () => {
  it("validates all selected files and shares the exact 2D content revision", async () => {
    const result = await validateSnapshot(root);
    const source = await sourceIdentity(root, 256 * 1024 * 1024, new AbortController().signal);
    expect(SNAPSHOT_VALIDATION_VERSION).toBe(1);
    expect(result).toMatchObject({
      format: "mapelix-snapshot-validation",
      schemaVersion: 1,
      valid: true,
      activeTables: 1,
      selectedJournals: 3,
      ignoredTables: 0,
      filesChecked: 6,
      revision: source.revision,
      errors: [],
      bytesChecked: source.files.reduce((sum, file) => sum + file.bytes, 0),
    });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("ignores unfinished and conflicting inactive tables plus obsolete WALs", async () => {
    const before = await validateSnapshot(root);
    await writeFile(join(root, "db", "038514.ldb"), new Uint8Array(79383));
    await writeFile(
      join(root, "db", "000004.ldb"),
      fixtureTableMetadata(4, [{ ...section(0, "minecraft:air"), sequence: 1000n }]).bytes,
    );
    await writeFile(join(root, "db", "000008.log"), "obsolete corrupt WAL");
    const after = await validateSnapshot(root);
    expect(after).toMatchObject({
      valid: true,
      revision: before.revision,
      ignoredTables: 2,
      filesChecked: before.filesChecked,
      bytesChecked: before.bytesChecked,
    });
  });

  it.each(["missing", "short", "footer", "late-block", "metadata", "filter"])(
    "rejects an active table fault: %s",
    async (fault) => {
      const path = join(root, "db", "000003.ldb");
      if (fault === "missing") await rm(path);
      else {
        const bytes = table.bytes.slice();
        const footer = readTableFooterHandles(bytes.subarray(bytes.length - 48), "table");
        if (fault === "footer") bytes[bytes.length - 1]! ^= 1;
        if (fault === "metadata") bytes[footer.metaindex.offset]! ^= 1;
        if (fault === "late-block" || fault === "filter") {
          const handle = fault === "filter" ? footer.metaindex : footer.index;
          const entries = parseTableBlock(
            readTableBlock(
              bytes.subarray(handle.offset, handle.offset + handle.size + 5),
              "table",
              true,
            ),
            "table",
          );
          const target = readBlockHandle(entries[fault === "filter" ? 0 : 1]!.value, "table");
          bytes[target.offset]! ^= 1;
        }
        await writeFile(path, fault === "short" ? bytes.subarray(0, bytes.length - 1) : bytes);
      }
      expect(await validateSnapshot(root)).toMatchObject({
        valid: false,
        revision: null,
        errors: [
          {
            code: fault === "missing" ? "ACTIVE_FILE_MISSING" : "ACTIVE_TABLE_INVALID",
            file: "db/000003.ldb",
          },
        ],
      });
    },
  );

  it("checks actual table key bounds against a well-formed manifest", async () => {
    await setManifest({
      ...table,
      smallest: internalFixtureKey({
        key: new Uint8Array([0]),
        value: new Uint8Array(),
        sequence: 1n,
      }),
    });
    expect(await validateSnapshot(root)).toMatchObject({
      valid: false,
      errors: [{ code: "ACTIVE_TABLE_INVALID", message: expect.stringContaining("bounds") }],
    });
  });

  it.each(["CURRENT", "manifest-crc", "unsupported"])(
    "never falls back when %s is invalid",
    async (fault) => {
      if (fault === "CURRENT") await writeFile(join(root, "db", "CURRENT"), "invalid");
      if (fault === "unsupported") await writeFixtureManifest(root, [new Uint8Array([100])]);
      if (fault === "manifest-crc") {
        const path = join(root, "db", "MANIFEST-000002");
        const bytes = await readFile(path);
        bytes[0]! ^= 1;
        await writeFile(path, bytes);
      }
      expect(await validateSnapshot(root)).toMatchObject({
        valid: false,
        revision: null,
        activeTables: null,
        errors: [
          {
            code:
              fault === "CURRENT"
                ? "CURRENT_INVALID"
                : fault === "unsupported"
                  ? "MANIFEST_UNSUPPORTED"
                  : "MANIFEST_INVALID",
          },
        ],
      });
    },
  );

  it.each(["000009.log", "000012.log", "000013.log"])(
    "checks every required journal %s",
    async (name) => {
      const path = join(root, "db", name);
      const bytes = await readFile(path);
      bytes[0]! ^= 1;
      await writeFile(path, bytes);
      expect(await validateSnapshot(root)).toMatchObject({
        valid: false,
        errors: [{ code: "REQUIRED_LOG_INVALID", file: `db/${name}` }],
      });
    },
  );

  it("hashes optional level.dat as opaque source metadata and respects logical table lengths", async () => {
    const before = await validateSnapshot(root);
    await writeFile(
      join(root, "db", "000003.ldb"),
      Buffer.concat([table.bytes, new Uint8Array(30)]),
    );
    expect(await validateSnapshot(root)).toMatchObject({
      valid: true,
      revision: before.revision,
      bytesChecked: before.bytesChecked,
    });
    await writeFile(join(root, "level.dat"), new Uint8Array([1, 2, 3]));
    const after = await validateSnapshot(root);
    expect(after).toMatchObject({
      valid: true,
      filesChecked: before.filesChecked + 1,
      bytesChecked: before.bytesChecked + 3,
    });
    expect(after.revision).not.toBe(before.revision);
  });

  it.each([{ maxInputFileBytes: 1 }, { maxTotalInputBytes: 10 }, { maxDecodedBlockBytes: 8 }])(
    "reports configured resource limits %j",
    async (options) => {
      expect(await validateSnapshot(root, options)).toMatchObject({
        valid: false,
        revision: null,
        errors: [{ code: "SNAPSHOT_LIMIT_EXCEEDED" }],
      });
    },
  );

  it("bounds decompression of a highly compressed table", async () => {
    table = fixtureTableMetadata(
      3,
      [{ key: encodeText("key"), value: new Uint8Array(1024 * 1024), sequence: 1n }],
      { compression: "zlib" },
    );
    await setManifest();
    await writeFile(join(root, "db", "000003.ldb"), table.bytes);
    expect(await validateSnapshot(root, { maxDecodedBlockBytes: 4096 })).toMatchObject({
      valid: false,
      errors: [{ code: "SNAPSHOT_LIMIT_EXCEEDED", file: "db/000003.ldb" }],
    });
  });

  it("cancels before any source reads and during asynchronous file validation", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await validateSnapshot("/not-read", { signal: controller.signal })).toMatchObject({
      valid: false,
      filesChecked: 0,
      errors: [{ code: "VALIDATION_CANCELLED" }],
    });
    const running = new AbortController();
    const pending = validateSnapshot(root, { signal: running.signal });
    running.abort();
    expect(await pending).toMatchObject({
      valid: false,
      errors: [{ code: "VALIDATION_CANCELLED" }],
    });
  });

  it("enforces a cooperative deadline", async () => {
    expect(await validateSnapshot(root, { timeoutMs: 1 })).toMatchObject({
      valid: false,
      errors: [{ code: "VALIDATION_TIMEOUT" }],
    });
  });

  it.each([
    { timeoutMs: 0 },
    { timeoutMs: 2147483648 },
    { maxInputFileBytes: NaN },
    { maxDecodedBlockBytes: -1 },
  ])("rejects invalid API options %j", async (options) => {
    await expect(validateSnapshot(root, options)).rejects.toBeInstanceOf(RangeError);
  });

  it("rejects a source changed between validation and the final identity check", async () => {
    const { stdout } = await run(process.execPath, [probe, apiEntry, root, "changed"]);
    expect(JSON.parse(stdout)).toMatchObject({
      valid: false,
      revision: null,
      errors: [{ code: "SOURCE_CHANGED" }],
    });
  });

  it.each([false, true])(
    "preserves read-only files on success/failure (corrupt=%s), with mutation calls forbidden",
    async (corrupt) => {
      if (corrupt) {
        const bytes = table.bytes.slice();
        bytes[0]! ^= 1;
        await writeFile(join(root, "db", "000003.ldb"), bytes);
      }
      await writeFile(join(root, "db", "038514.ldb"), new Uint8Array(79383));
      for (const name of await readdir(join(root, "db")))
        await chmod(join(root, "db", name), 0o444);
      await chmod(join(root, "db"), 0o555);
      await chmod(root, 0o555);
      async function inventory() {
        return Promise.all(
          (await readdir(join(root, "db"))).sort().map(async (name) => {
            const path = join(root, "db", name);
            const info = await stat(path);
            return {
              name,
              mode: info.mode,
              mtime: info.mtimeMs,
              ctime: info.ctimeMs,
              hash: sha256(await readFile(path)),
            };
          }),
        );
      }
      const before = await inventory();
      const { stdout } = await run(process.execPath, [probe, apiEntry, root, "readonly"]);
      expect(JSON.parse(stdout)).toMatchObject({ valid: !corrupt });
      expect(await inventory()).toEqual(before);
    },
  );
});
