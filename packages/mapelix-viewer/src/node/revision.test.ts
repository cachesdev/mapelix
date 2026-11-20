import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { worldRevision } from "./revision.js";
import { scanWorldExtent } from "./extent.js";

let world: string;
beforeEach(async () => {
  world = await mkdtemp(join(tmpdir(), "mapelix-revision-"));
  await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:stone")]);
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

describe("selected 3D world revision", () => {
  it("ignores inactive tables, old WALs and diagnostic files", async () => {
    const before = await worldRevision(world, "engine");
    for (const name of ["038514.ldb", "000000.log", "LOG", "LOCK", "MANIFEST-000099"])
      await writeFile(join(world, "db", name), "inactive");
    expect(await worldRevision(world, "engine")).toBe(before);
  });

  it("changes with active data, recovery metadata, or engine identity", async () => {
    const before = await worldRevision(world, "engine");
    expect(await worldRevision(world, "new-engine")).not.toBe(before);
    await writeFixtureWorld(world, [
      sectionRecord(0, 0, 0, 4, "minecraft:red_wool"),
      sectionRecord(0, 1, 0, 4, "minecraft:stone"),
    ]);
    expect(await worldRevision(world, "engine")).not.toBe(before);
    await writeFile(join(world, "db", "CURRENT"), "invalid");
    await expect(worldRevision(world, "engine")).rejects.toMatchObject({ code: "CURRENT_INVALID" });
  });

  it("ignores inactive corrupt tables while scanning stored coverage", async () => {
    const before = await scanWorldExtent(world);
    await writeFile(join(world, "db", "038514.ldb"), new Uint8Array(79383));
    expect(await scanWorldExtent(world)).toEqual(before);
    expect(before.overworld).toEqual({ minX: 0, minZ: 0, maxX: 15, maxZ: 15 });
    await writeFile(join(world, "db", "000001.log"), "invalid active journal");
    await expect(scanWorldExtent(world)).rejects.toMatchObject({ code: "REQUIRED_LOG_INVALID" });
  });
});
