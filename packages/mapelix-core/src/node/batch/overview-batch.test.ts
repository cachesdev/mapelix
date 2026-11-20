import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decodePng } from "@mapelix/prototype/png";
import { afterEach, describe, expect, it } from "vitest";

import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { renderBatch } from "../../../dist/node/batch/index.js";
import type { BatchOptions, BatchResult, BatchTile } from "./types.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  world: string;
  output: string;
  options: BatchOptions;
}> {
  const root = await mkdtemp(join(tmpdir(), "mapelix-overview-"));
  roots.push(root);
  const world = join(root, "world");
  const output = join(root, "export");
  await writeFixtureWorld(world, [
    sectionRecord(0, -1, -1, 3, "minecraft:red_wool"),
    sectionRecord(0, 0, -1, 3, "minecraft:blue_wool"),
    sectionRecord(0, -1, 0, 3, "minecraft:gold_block"),
    sectionRecord(0, 0, 0, 3, "minecraft:grass_block"),
    sectionRecord(1, 0, 0, 5, "minecraft:gold_block"),
    sectionRecord(1, 0, 0, 7, "minecraft:bedrock"),
    sectionRecord(2, 0, 0, 4, "minecraft:end_stone"),
  ]);
  return {
    root,
    world,
    output,
    options: { world, output, shadows: "off", limits: { workers: 1 } },
  };
}

async function readTile(output: string, result: BatchResult, tile: BatchTile): Promise<Uint8Array> {
  return decodePng(await readFile(join(output, result.manifest.tileBase, tile.path)), 256, 256);
}

describe("bounded overview export", () => {
  it("exports every default zoom for three dimensions with the same native pixels and deterministic workers", async () => {
    const { options, output } = await fixture();
    const first = await renderBatch(options);
    expect(first.manifest.grid.zooms).toEqual([-4, -3, -2, -1, 0, 1, 2]);
    expect(first.manifest.tileCount).toBe(150);
    expect(first.manifest.grid.overview).toEqual({
      sourceZoom: 0,
      filter: "area-premultiplied-srgb-v1",
    });
    expect(first.manifest.work).toEqual({ tileJobs: 150, temporaryTiles: 0, temporaryPngBytes: 0 });
    const originalNative = await renderBatch({ ...options, zooms: [0, 1, 2] });
    expect(first.manifest.tiles.filter((tile) => tile.z >= 0)).toEqual(
      originalNative.manifest.tiles,
    );
    const second = await renderBatch({ ...options, limits: { workers: 2, maxPending: 3 } });
    expect(second.manifest).toEqual(first.manifest);
    const overview = first.manifest.tiles.find(
      (tile) => tile.dimension === "overworld" && tile.z === -4 && tile.x === -1 && tile.y === -1,
    )!;
    const rgba = await readTile(output, first, overview);
    expect(rgba[(255 * 256 + 255) * 4 + 3]).toBe(255);
    expect(rgba[3]).toBe(0);
    expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
  }, 30_000);

  it("renders omitted zoom-zero sources once and publishes only the requested negative zooms", async () => {
    const { options, output } = await fixture();
    const result = await renderBatch({ ...options, zooms: [-4, -1] });
    expect(result.manifest.tileCount).toBe(12);
    expect(result.manifest.work).toMatchObject({ tileJobs: 18, temporaryTiles: 6 });
    expect(result.manifest.work!.temporaryPngBytes).toBeGreaterThan(0);
    expect(result.manifest.tiles.every((tile) => tile.z === -4 || tile.z === -1)).toBe(true);
    const rootEntries = await readdir(join(output, result.manifest.tileBase));
    expect(rootEntries.sort()).toEqual([
      "manifest.json",
      "nether",
      "overworld",
      "source-chunks.json",
      "the-end",
    ]);
    expect(
      (await readdir(join(output, result.manifest.tileBase, "overworld", "tiles"))).sort(),
    ).toEqual(["-1", "-4"]);
    const repeated = await renderBatch({
      ...options,
      zooms: [-1, -4],
      limits: { workers: 2, maxPending: 1 },
    });
    expect(repeated.manifest).toEqual(result.manifest);
  }, 20_000);

  it("enforces hidden work and byte limits without replacing a previous publication", async () => {
    const { options, output } = await fixture();
    const result = await renderBatch({ ...options, zooms: [-4, -1] });
    const before = await readFile(result.manifestPath, "utf8");
    await expect(
      renderBatch({ ...options, zooms: [-4, -1], limits: { workers: 1, maxTiles: 17 } }),
    ).rejects.toThrow("overview sources exceeds maxTiles");
    const bytes =
      result.manifest.pngBytes +
      result.manifest.work!.temporaryPngBytes +
      result.manifest.sourceChunks!.bytes +
      Buffer.byteLength(before) +
      (await readFile(join(output, result.manifest.tileBase, "manifest.json"))).byteLength;
    await expect(
      renderBatch({
        ...options,
        zooms: [-4, -1],
        limits: { workers: 1, maxOutputBytes: bytes - 1 },
      }),
    ).rejects.toThrow("Manifest and PNG output");
    expect(await readFile(result.manifestPath, "utf8")).toBe(before);
    const exact = await renderBatch({
      ...options,
      zooms: [-4, -1],
      limits: { workers: 1, maxTiles: 18, maxOutputBytes: bytes },
    });
    expect(exact.manifest).toEqual(result.manifest);
    expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
  }, 20_000);

  it.each([-4, -1])(
    "keeps complete overview pixels beyond a narrow bounds selection at %i",
    async (zoom) => {
      const { options, world, output } = await fixture();
      await writeFixtureWorld(world, [
        sectionRecord(0, 0, 0, 3, "minecraft:red_wool"),
        sectionRecord(0, 16, 0, 3, "minecraft:gold_block"),
      ]);
      const selected = await renderBatch({
        ...options,
        dimensions: ["overworld"],
        zooms: [zoom, 0],
        bounds: { minX: 0, minZ: 0, maxX: 1, maxZ: 1 },
      });
      expect(selected.manifest.work).toMatchObject({ tileJobs: 3, temporaryTiles: 1 });
      const entire = await renderBatch({ ...options, dimensions: ["overworld"], zooms: [zoom] });
      const tile = selected.manifest.tiles.find((value) => value.z === zoom)!;
      expect(tile.sha256).toBe(entire.manifest.tiles[0]!.sha256);
      const rgba = await readTile(output, selected, tile);
      const x = zoom === -4 ? 16 : 128;
      expect(rgba[x * 4 + 3]).toBe(255);
    },
    15_000,
  );

  it("cancels after overview composition starts and removes stage-only source PNGs", async () => {
    const { options, world, output } = await fixture();
    const published = await renderBatch({ ...options, zooms: [0] });
    const before = await readFile(published.manifestPath, "utf8");
    // Sparse cells force many overview outputs while each native fixture remains small.
    await writeFixtureWorld(
      world,
      Array.from({ length: 32 }, (_, index) =>
        sectionRecord(0, index * 256, 0, 3, "minecraft:stone"),
      ),
    );
    const controller = new AbortController();
    const pending = renderBatch({
      ...options,
      dimensions: ["overworld"],
      zooms: [-4, -3, -2, -1],
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    let composing = false;
    try {
      for (let wait = 0; wait < 1500; wait++) {
        const stage = (await readdir(output)).find((name) => name.startsWith(".mapelix-staging-"));
        if (stage !== undefined) {
          try {
            await readdir(join(output, stage, "overworld", "tiles", "-4"));
            composing = true;
            break;
          } catch (cause) {
            if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
              throw cause;
          }
        }
        await delay(5);
      }
    } finally {
      controller.abort();
    }
    await rejected;
    expect(composing).toBe(true);
    expect(await readFile(published.manifestPath, "utf8")).toBe(before);
    expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
    expect(await readdir(join(output, "generations"))).toEqual([published.manifest.generation]);
  }, 25_000);
});
