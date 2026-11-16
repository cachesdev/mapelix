import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { renderBatch } from "../../../dist/node/batch/index.js";
import type { BatchOptions } from "./types.js";

const roots: string[] = [];
const run = promisify(execFile);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  world: string;
  output: string;
  options: BatchOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "mapelix-batch-"));
  roots.push(root);
  const world = join(root, "world");
  const output = join(root, "output");
  await writeFixtureWorld(world, [
    sectionRecord(0, -1, -1, 3, "minecraft:grass_block"),
    sectionRecord(1, 0, 0, 5, "minecraft:gold_block"),
    sectionRecord(1, 0, 0, 7, "minecraft:bedrock"),
    sectionRecord(2, 0, 0, 4, "minecraft:end_stone"),
  ]);
  return {
    root,
    world,
    output,
    options: { world, output, zooms: [0], shadows: "off", limits: { workers: 1 } },
  };
}

async function leftovers(output: string): Promise<string[]> {
  return (await readdir(output)).filter((name) => name.startsWith(".mapelix"));
}

describe("atomic snapshot batch export", () => {
  it("removes an unpublished payload when the final publication rename fails", async () => {
    const { options, world, output } = await fixture();
    const first = await renderBatch(options);
    const before = await readFile(first.manifestPath, "utf8");
    const script = fileURLToPath(new URL("../../../test/batch-process.mjs", import.meta.url));
    const { stdout } = await run(process.execPath, [script, world, output, "publish-error"], {
      timeout: 8000,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      message: "Expected publication rename failure",
      ports: 0,
    });
    expect(await readFile(first.manifestPath, "utf8")).toBe(before);
    expect(await readdir(join(output, "generations"))).toEqual([first.manifest.generation]);
    expect(await leftovers(output)).toEqual([]);
  }, 12_000);

  it.each(["crash", "abort", "timeout", "memory"])(
    "exits naturally after %s with no remaining message ports",
    async (mode) => {
      const { world, output } = await fixture();
      const script = fileURLToPath(new URL("../../../test/batch-process.mjs", import.meta.url));
      const { stdout, stderr } = await run(process.execPath, [script, world, output, mode], {
        timeout: 8000,
      });
      expect(stderr).toBe("");
      const value = JSON.parse(stdout) as { name: string; message: string; ports: number };
      expect(value.ports).toBe(0);
      if (mode === "crash") expect(value.message).toContain("coordinator exited");
      else
        expect(value.name).toBe(
          mode === "abort" ? "AbortError" : mode === "memory" ? "MemoryLimitError" : "TimeoutError",
        );
      expect(await leftovers(output)).toEqual([]);
      await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    12_000,
  );

  it("publishes complete verified tiles for all dimensions and is deterministic across worker counts", async () => {
    const { options, output, world } = await fixture();
    const source = await readFile(join(world, "db", "000001.log"));
    const first = await renderBatch(options);
    expect(first.manifest.tileCount).toBe(3);
    expect(
      first.manifest.render.profiles.find((profile) => profile.dimension === "nether")!.topY,
    ).toBe(90);
    const contents = await readFile(first.manifestPath, "utf8");
    for (const tile of first.manifest.tiles) {
      const png = await readFile(join(output, first.manifest.tileBase, tile.path));
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(256);
      expect(png.readUInt32BE(20)).toBe(256);
      expect(createHash("sha256").update(png).digest("hex")).toBe(tile.sha256);
    }
    const second = await renderBatch({ ...options, limits: { workers: 2, maxPending: 3 } });
    expect(second.manifest).toEqual(first.manifest);
    expect(await readFile(second.manifestPath, "utf8")).toBe(contents);
    expect(await readFile(join(world, "db", "000001.log"))).toEqual(source);
    expect(await leftovers(output)).toEqual([]);
    expect(await readdir(join(output, "generations"))).toEqual([first.manifest.generation]);
  }, 20_000);

  it.each([{ maxTiles: 1 }, { maxOutputBytes: 1 }, { maxInputFileBytes: 1 }, { timeoutMs: 1 }])(
    "preserves the current publication and cleans owned files on limit failure %j",
    async (limits) => {
      const { options, output } = await fixture();
      const first = await renderBatch(options);
      const before = await readFile(first.manifestPath, "utf8");
      await expect(
        renderBatch({ ...options, limits: { workers: 1, ...limits } }),
      ).rejects.toThrow();
      expect(await readFile(first.manifestPath, "utf8")).toBe(before);
      expect(await leftovers(output)).toEqual([]);
      expect(await readdir(join(output, "generations"))).toEqual([first.manifest.generation]);
    },
    20_000,
  );

  it("counts both manifests in the exact inclusive output byte limit", async () => {
    const { options, output } = await fixture();
    const first = await renderBatch(options);
    const bytes =
      first.manifest.pngBytes +
      first.manifest.sourceChunks!.bytes +
      (await readFile(first.manifestPath)).byteLength +
      (await readFile(join(output, first.manifest.tileBase, "manifest.json"))).byteLength;
    await expect(
      renderBatch({ ...options, limits: { workers: 1, maxOutputBytes: bytes - 1 } }),
    ).rejects.toThrow("Manifest and PNG output");
    const exact = await renderBatch({ ...options, limits: { workers: 1, maxOutputBytes: bytes } });
    expect(exact.manifest.generation).toBe(first.manifest.generation);
    expect(await leftovers(output)).toEqual([]);
  }, 15_000);

  it("cancels before startup and on a memory limit without creating output", async () => {
    const { options, output } = await fixture();
    await expect(renderBatch({ ...options, signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: "AbortError",
    });
    await expect(renderBatch({ ...options, limits: { memoryBudgetMiB: 1 } })).rejects.toMatchObject(
      { name: "MemoryLimitError" },
    );
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an accepted run and releases the output lock", async () => {
    const { options, output } = await fixture();
    const controller = new AbortController();
    const pending = renderBatch({ ...options, zooms: [3], signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const timer = setTimeout(() => controller.abort(), 150);
    try {
      await rejected;
    } finally {
      clearTimeout(timer);
    }
    expect(await leftovers(output)).toEqual([]);
    await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 10_000);

  it("detects source mutation after indexing and refuses another writer during rendering", async () => {
    const { options, world, output } = await fixture();
    await writeFile(join(world, "level.dat"), "initial fixture metadata");
    const pending = renderBatch({ ...options, zooms: [2], limits: { workers: 1, maxPending: 1 } });
    const rejected = expect(pending).rejects.toThrow("Source snapshot changed");
    let beganRendering = false;
    for (let wait = 0; wait < 400; wait++) {
      try {
        const stage = (await readdir(output)).find((name) => name.startsWith(".mapelix-staging-"));
        if (stage !== undefined && (await readdir(join(output, stage))).length > 0) {
          beganRendering = true;
          break;
        }
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
      }
      await delay(5);
    }
    expect(beganRendering).toBe(true);
    await expect(renderBatch(options)).rejects.toThrow("output lock");
    await writeFile(join(world, "level.dat"), "changed fixture metadata");
    await rejected;
    expect(await leftovers(output)).toEqual([]);
    await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it("rejects source/output overlap and a nonexistent output parent", async () => {
    const { options, world, root } = await fixture();
    await expect(renderBatch({ ...options, output: join(world, "export") })).rejects.toThrow(
      "disjoint",
    );
    await expect(renderBatch({ ...options, output: root })).rejects.toThrow("disjoint");
    await expect(
      renderBatch({ ...options, output: join(root, "missing", "export") }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(join(world, "export"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects input/output junctions and linked database files", async () => {
    const { options, root, world, output } = await fixture();
    const alias = join(root, "alias");
    await symlink(world, alias, "junction");
    await expect(renderBatch({ ...options, world: alias })).rejects.toThrow("junctions");
    await symlink(world, output, "junction");
    await expect(renderBatch(options)).rejects.toThrow("junctions");
    // A source entry with a database suffix must be a regular file, not a linked directory.
    await symlink(world, join(world, "db", "linked.log"), "junction");
    await expect(renderBatch({ ...options, output: join(root, "other") })).rejects.toThrow(
      "junctions",
    );
  });

  it("refuses a foreign manifest and never steals an existing output lock", async () => {
    const { options, output } = await fixture();
    await mkdir(output);
    await writeFile(join(output, "manifest.json"), '{"application":"unrelated"}');
    await expect(renderBatch(options)).rejects.toThrow("unrelated");
    expect(await readFile(join(output, "manifest.json"), "utf8")).toBe(
      '{"application":"unrelated"}',
    );
    expect(await leftovers(output)).toEqual([]);
    await writeFile(join(output, ".mapelix.lock"), "another-owner");
    await expect(renderBatch(options)).rejects.toThrow("output lock");
    expect(await readFile(join(output, ".mapelix.lock"), "utf8")).toBe("another-owner");
  });

  it("refuses a corrupted existing immutable payload instead of replacing it", async () => {
    const { options, output } = await fixture();
    const first = await renderBatch(options);
    const path = join(output, first.manifest.tileBase, first.manifest.tiles[0]!.path);
    await writeFile(path, "corrupt");
    const before = await readFile(first.manifestPath, "utf8");
    await expect(renderBatch(options)).rejects.toThrow("digest mismatch");
    expect(await readFile(first.manifestPath, "utf8")).toBe(before);
    expect(await readFile(path, "utf8")).toBe("corrupt");
    expect(await leftovers(output)).toEqual([]);
  }, 20_000);

  it("allows an empty dimension and changes identity when render settings change", async () => {
    const { options, output } = await fixture();
    const empty = await renderBatch({
      ...options,
      dimensions: ["overworld"],
      bounds: { minX: 256, minZ: 256, maxX: 257, maxZ: 257 },
    });
    expect(empty.manifest.tiles).toEqual([]);
    const changed = await renderBatch({ ...options, dimensions: ["overworld"], topY: 20 });
    expect(changed.manifest.generation).not.toBe(empty.manifest.generation);
    expect((await readdir(join(output, "generations"))).sort()).toEqual(
      [empty.manifest.generation, changed.manifest.generation].sort(),
    );
  }, 20_000);
});
import { execFile } from "node:child_process";
