import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLevelDbRecords } from "@mapelix/prototype/bedrock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorldDatabase } from "./world-database.js";

const run = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../../../mapelix-prototype/test/fixtures/2000world.mcworld", import.meta.url),
);

describe("seekable world database", () => {
  let directory: string;
  let database: WorldDatabase;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-scene-fixture-"));
    await run("unzip", ["-qq", fixture, "-d", directory]);
    database = WorldDatabase.open(directory);
  });

  afterAll(async () => {
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("returns the same live records as a full scan for every chunk", async () => {
    const names = await readdir(join(directory, "db"));
    const files = await Promise.all(
      names.map(async (name) => ({ name, bytes: await readFile(join(directory, "db", name)) })),
    );
    const expected = new Map<string, Map<string, string>>();
    for (const record of readLevelDbRecords(files)) {
      // Overworld chunk records start with the two little-endian chunk coordinates.
      if (record.key.length !== 9 && record.key.length !== 10) continue;
      const prefix = hex(record.key.subarray(0, 8));
      const chunk = expected.get(prefix) ?? new Map<string, string>();
      chunk.set(hex(record.key), hex(record.value));
      expected.set(prefix, chunk);
    }
    expect(expected.size).toBeGreaterThan(10);

    for (const [prefix, records] of expected) {
      const found = new Map<string, string>();
      for (const record of database.readPrefix(bytes(prefix))) {
        if (record.key.length === 9 || record.key.length === 10) {
          found.set(hex(record.key), hex(record.value));
        }
      }
      expect(found).toEqual(records);
    }
  });
});

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}
