import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tileBounds, tileDependencyBounds } from "@mapelix/prototype";
import { afterEach, describe, expect, it } from "vitest";

import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { renderBatch } from "../../../dist/node/batch/index.js";
import { changedChunks, dirtyTiles } from "./incremental.js";
import { tilePath } from "./plan.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dirtyTiles", () => {
  it.each([
    { shadows: "opacity" as const, biomeBlendRadius: 0 },
    { shadows: "opacity" as const, biomeBlendRadius: 5 },
    { shadows: "off" as const, biomeBlendRadius: 0 },
    { shadows: "off" as const, biomeBlendRadius: 16 },
  ])(
    "matches a brute-force dependency scan with $shadows shadows and blend $biomeBlendRadius",
    (settings) => {
      const chunks = [
        [0, 0],
        [-1, -1],
        [15, 16],
        [-17, 3],
        [31, -32],
      ] as const;
      const batch = { zooms: [-2, -1, 0, 1, 2], ...settings };
      const dirty = dirtyTiles(new Map([["overworld", chunks]]), batch);
      const expected = new Set<string>();
      for (const z of [0, 1, 2]) {
        const span = 256 / 2 ** z;
        for (let y = Math.floor(-1024 / span); y <= Math.floor(1024 / span); y += 1) {
          for (let x = Math.floor(-1024 / span); x <= Math.floor(1024 / span); x += 1) {
            const tile = { dimension: "overworld" as const, z, x, y };
            const bounds = tileDependencyBounds(tile, {
              shadows: settings.shadows !== "off",
              biomeBlendRadius: settings.biomeBlendRadius,
            });
            if (
              chunks.some(
                ([cx, cz]) =>
                  cx * 16 < bounds.maxX &&
                  cx * 16 + 16 > bounds.minX &&
                  cz * 16 < bounds.maxZ &&
                  cz * 16 + 16 > bounds.minZ,
              )
            ) {
              expected.add(tilePath(tile));
              if (z === 0)
                for (const zoom of [-2, -1]) {
                  const scale = 2 ** -zoom;
                  expected.add(
                    tilePath({
                      ...tile,
                      z: zoom,
                      x: Math.floor(x / scale),
                      y: Math.floor(y / scale),
                    }),
                  );
                }
            }
          }
        }
      }
      expect([...dirty].sort()).toEqual([...expected].sort());
    },
  );

  it("reports changed, deleted and added chunks", () => {
    const before = new Map([
      [
        "overworld" as const,
        new Map([
          ["0,0", "a"],
          ["1,0", "b"],
          ["2,0", "c"],
        ]),
      ],
    ]);
    const after = new Map([
      [
        "overworld" as const,
        new Map([
          ["0,0", "a"],
          ["1,0", "B"],
          ["3,0", "d"],
        ]),
      ],
    ]);
    expect(
      changedChunks(before, after)
        .get("overworld")
        ?.map((row) => row.join(","))
        .sort(),
    ).toEqual(["1,0", "2,0", "3,0"]);
    expect(tileBounds({ dimension: "overworld", z: 0, x: 0, y: 0 }).maxX).toBe(256);
  });
});

describe("incremental batch export", () => {
  it("keeps the publication and cached surfaces stable when inactive files appear", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapelix-inactive-"));
    roots.push(root);
    const world = join(root, "world");
    await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:stone")]);
    const options = {
      world,
      output: join(root, "export"),
      zooms: [0],
      shadows: "off" as const,
      dimensions: ["overworld" as const],
      incremental: true,
      surfaceCacheMiB: 16,
      limits: { workers: 1 },
    };
    const first = await renderBatch(options);
    await writeFile(join(world, "db", "038514.ldb"), new Uint8Array(79383));
    await writeFile(join(world, "db", "000000.log"), "obsolete broken journal");
    const unchanged = await renderBatch(options);
    expect(unchanged.update).toMatchObject({
      mode: "incremental",
      changedChunks: 0,
      renderedTiles: 0,
    });
    expect(unchanged.manifest.generation).toBe(first.manifest.generation);
    expect(unchanged.manifest.source).toEqual(first.manifest.source);
    await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:gold_block")]);
    const updated = await renderBatch(options);
    const full = await renderBatch({ ...options, output: join(root, "full"), incremental: false });
    expect(updated.update).toMatchObject({
      mode: "incremental",
      changedChunks: 1,
      renderedTiles: 1,
    });
    expect(updated.manifest.tiles).toEqual(full.manifest.tiles);
    expect(updated.manifest.generation).toBe(full.manifest.generation);
  }, 30_000);

  it("reuses unaffected tiles and matches a full render of the updated world", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapelix-incremental-"));
    roots.push(root);
    const before = join(root, "before");
    const after = join(root, "after");
    await writeFixtureWorld(before, [
      sectionRecord(0, 0, 0, 4, "minecraft:grass_block"),
      sectionRecord(0, 40, 40, 4, "minecraft:stone"),
      sectionRecord(0, -30, 5, 6, "minecraft:gold_block"),
    ]);
    await writeFixtureWorld(after, [
      sectionRecord(0, 0, 0, 4, "minecraft:grass_block"),
      sectionRecord(0, 40, 40, 5, "minecraft:red_wool"),
      sectionRecord(0, 60, 0, 3, "minecraft:blue_wool"),
    ]);
    const options = {
      zooms: [-1, 0, 1],
      dimensions: ["overworld" as const],
      limits: { workers: 1 },
    };
    const output = join(root, "export");

    const first = await renderBatch({ ...options, world: before, output, incremental: true });
    expect(first.update).toMatchObject({ mode: "full", reason: "no published generation" });
    expect(first.manifest.sourceChunks?.path).toBe("source-chunks.json");

    const unchanged = await renderBatch({ ...options, world: before, output, incremental: true });
    expect(unchanged.update).toMatchObject({
      mode: "incremental",
      changedChunks: 0,
      renderedTiles: 0,
    });
    expect(unchanged.manifest.generation).toBe(first.manifest.generation);

    const updated = await renderBatch({ ...options, world: after, output, incremental: true });
    const full = await renderBatch({ ...options, world: after, output: join(root, "full") });
    expect(updated.update).toMatchObject({ mode: "incremental", changedChunks: 3 });
    expect(updated.update.reusedTiles).toBeGreaterThan(0);
    expect(updated.update.renderedTiles).toBeLessThan(full.update.renderedTiles);
    expect(updated.manifest.generation).toBe(full.manifest.generation);
    expect(updated.manifest.tiles).toEqual(full.manifest.tiles);

    const changedSettings = await renderBatch({
      ...options,
      world: after,
      output,
      incremental: true,
      shadows: "off",
    });
    expect(changedSettings.update).toMatchObject({
      mode: "full",
      reason: "render settings changed",
    });
  }, 60_000);

  it("reads cached chunk surfaces without changing any tile", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapelix-surface-cache-"));
    roots.push(root);
    const before = join(root, "before");
    const after = join(root, "after");
    await writeFixtureWorld(before, [
      sectionRecord(0, 0, 0, 4, "minecraft:grass_block"),
      sectionRecord(0, 3, 2, 5, "minecraft:stone"),
      sectionRecord(0, 40, 40, 4, "minecraft:stone"),
    ]);
    await writeFixtureWorld(after, [
      sectionRecord(0, 0, 0, 4, "minecraft:grass_block"),
      sectionRecord(0, 3, 2, 6, "minecraft:red_wool"),
      sectionRecord(0, 40, 40, 4, "minecraft:stone"),
    ]);
    const options = {
      zooms: [-1, 0, 1],
      dimensions: ["overworld" as const],
      limits: { workers: 1 },
      incremental: true,
      surfaceCache: { maxMiB: 16 },
    };
    const output = join(root, "export");
    const cache = join(output, ".mapelix-surface-cache");
    const first = await renderBatch({ ...options, world: before, output });
    expect(first.update.surfaceCache).toMatchObject({ hits: 0 });
    expect(first.update.surfaceCache!.stored).toBeGreaterThan(0);
    expect(first.update.surfaceCache!.totalBytes).toBeGreaterThan(0);

    const full = await renderBatch({
      zooms: options.zooms,
      dimensions: options.dimensions,
      limits: options.limits,
      world: after,
      output: join(root, "full"),
    });
    const updated = await renderBatch({ ...options, world: after, output });
    expect(updated.update.mode).toBe("incremental");
    expect(updated.update.surfaceCache!.hits).toBeGreaterThan(0);
    expect(updated.manifest.generation).toBe(full.manifest.generation);

    // Damaged packs are ignored; the result is unchanged.
    const packs = await packFiles(cache);
    expect(packs.length).toBeGreaterThan(0);
    for (const pack of packs) {
      const bytes = await readFile(pack);
      bytes[Math.floor(bytes.byteLength / 2)]! ^= 0xff;
      await writeFile(pack, bytes);
    }
    await rm(join(output, "manifest.json"));
    const damaged = await renderBatch({ ...options, world: after, output });
    expect(damaged.update.surfaceCache).toMatchObject({ hits: 0 });
    expect(damaged.update.surfaceCache!.rejected).toBeGreaterThan(0);
    expect(damaged.manifest.generation).toBe(full.manifest.generation);

    // A deleted cache is rebuilt; a linked one is refused.
    await rm(cache, { recursive: true });
    await rm(join(output, "manifest.json"));
    const rebuilt = await renderBatch({ ...options, world: after, output });
    expect(rebuilt.manifest.generation).toBe(full.manifest.generation);
    await rm(cache, { recursive: true });
    await mkdir(join(root, "elsewhere"));
    await symlink(join(root, "elsewhere"), cache, "junction");
    await expect(renderBatch({ ...options, world: after, output })).rejects.toThrow(/links/i);
    expect(await readdir(join(root, "elsewhere"))).toEqual([]);
  }, 90_000);
});

async function packFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith(".pack"))
      files.push(join(entry.parentPath, entry.name));
  }
  return files;
}
