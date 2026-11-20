import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readLevelDbRecords } from "@mapelix/prototype/bedrock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { WorldDatabase } from "./world-database.js";
import { RegionBuilder } from "../node/region-builder.js";

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

  // LOD 0 includes the optional lava subtype/flow bits (15 lava quads in this fixture).
  // The independent database scan and the color/model tests check the underlying behavior.
  it.each([
    [0, "798dca699dcb7056f79843c0fe901cf1d558d9d5bd06170a50b6f4ec5a75ac6a"],
    [1, "9561b7885f05d2a3fc65b1a8c4e7136e5aa573bd4746259a3d79214ccdbc044e"],
    [3, "32e3f3b9a1617644c3b461289e4631a23145016e01aa357ce18e99b9b89093d7"],
    [5, "bc6df017a53fa90c79f3cfd9e85cf3f25331d0693c702f43fd1acbcda61aae66"],
  ] as const)("matches sampled-palette Overworld region bytes at LOD %i", (level, expected) => {
    const builder = new RegionBuilder({ directory, dimension: "overworld" });
    try {
      const bytes = builder.build({ level, x: 0, z: 0 });
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected);
    } finally {
      builder.close();
    }
  });
});

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}
