import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeText,
  fixtureEdit,
  fixtureTable,
  writeFixtureManifest,
} from "../../../../mapelix-prototype/test/leveldb-fixture.js";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { sourceIdentity } from "./identity.js";

let world: string;
const signal = new AbortController().signal;
const identify = () => sourceIdentity(world, 4096, signal);
beforeEach(async () => {
  world = await mkdtemp(join(tmpdir(), "mapelix-identity-"));
  await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:stone")]);
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

describe("selected source identity", () => {
  it("ignores inactive contents, oversize files and obsolete journals", async () => {
    const before = await identify();
    await writeFile(join(world, "db", "038514.ldb"), new Uint8Array(79383));
    await writeFile(join(world, "db", "000000.log"), encodeText("obsolete"));
    await writeFile(join(world, "db", "LOG"), encodeText("human diagnostic"));
    expect(await identify()).toEqual(before);
    expect(before.files.map(({ path }) => path)).toEqual([
      "db/000001.log",
      "db/CURRENT",
      "db/MANIFEST-000002",
    ]);
  });

  it("hashes logical table bytes and includes recovery metadata", async () => {
    const table = fixtureTable([
      { key: encodeText("key"), value: encodeText("value"), sequence: 1n },
    ]);
    await writeFile(join(world, "db", "000003.ldb"), table);
    await writeFixtureManifest(world, [
      fixtureEdit({
        logNumber: 1,
        nextFileNumber: 4,
        lastSequence: 1,
        added: [{ number: 3, bytes: table }],
      }),
    ]);
    const before = await identify();
    await appendFile(join(world, "db", "000003.ldb"), new Uint8Array(100));
    expect(await identify()).toEqual(before);
    expect(before.files.find(({ path }) => path === "db/000003.ldb")?.bytes).toBe(table.length);
  });

  it("changes when active writes change and rejects an invalid manifest", async () => {
    const before = await identify();
    await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:gold_block")]);
    expect((await identify()).revision).not.toBe(before.revision);
    await writeFile(join(world, "db", "MANIFEST-000002"), encodeText("invalid"));
    await expect(identify()).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });
});
