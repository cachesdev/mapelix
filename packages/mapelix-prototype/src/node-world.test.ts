import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { openBedrockWorld } from "./node-world.js";
import { writeFixtureManifest, fixtureLog } from "../test/leveldb-fixture.js";

const run = promisify(execFile);
const lifecycleScript = fileURLToPath(new URL("../test/world-lifecycle.mjs", import.meta.url));

describe("openBedrockWorld", () => {
  it.each([1, 2])(
    "keeps serializable render options in %i real workers",
    async (concurrency) => {
      expect(await runLifecycle("options", concurrency, "worker-options.mjs")).toMatchObject({
        completed: true,
        jobs: 4,
        messagePorts: 0,
      });
    },
    15_000,
  );

  it.each(["callback", "clone-error"])(
    "settles %s failures and remains usable",
    async (scenario) => {
      expect(await runLifecycle(scenario, 1, "worker-options.mjs")).toMatchObject({
        completed: true,
        messagePorts: 0,
      });
    },
    15_000,
  );

  it("rejects already cancelled startup before reading any files", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      openBedrockWorld({ directory: "/not-read", signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each([1, 2])(
    "aborts accepted renders and exits with %i workers",
    async (concurrency) => {
      const result = await runLifecycle("abort", concurrency);
      expect(result).toMatchObject({
        sameClosePromise: true,
        terminated: concurrency === 1 ? 0 : concurrency,
        messagePorts: 0,
        rejectedAfterClose: true,
        coverageRejected: true,
      });
      expect(result.rejected!.length).toBeGreaterThan(0);
      expect(result.fulfilled! + result.rejected!.length).toBe(5);
      expect(result.rejectedNames).toEqual(result.rejected!.map(() => "AbortError"));
      expect(result.rejected!.every((message) => /abort/i.test(message))).toBe(true);
    },
    15_000,
  );

  it("can escalate a graceful close to abort without leaving accepted promises pending", async () => {
    const result = await runLifecycle("abort-escalate", 2);
    expect(result).toMatchObject({
      sameClosePromise: true,
      terminated: 2,
      messagePorts: 0,
    });
    expect(result.fulfilled! + result.rejected!.length).toBe(5);
    expect(result.rejected!.length).toBeGreaterThan(0);
    expect(result.rejectedNames).toEqual(result.rejected!.map(() => "AbortError"));
  }, 15_000);

  it.each(["read-error-idle", "worker-exit-idle"])(
    "exits naturally after %s even without an explicit close",
    async (scenario) => {
      const result = await runLifecycle(scenario, 2);
      expect(result).toMatchObject({ completed: true, terminated: 0 });
      expect(result.failure).toEqual(
        expect.stringContaining(scenario === "read-error-idle" ? "ENOENT" : "render worker exited"),
      );
    },
    15_000,
  );

  it.each([1, 2, 4])(
    "drains accepted renders, closes %i workers, and exits without process.exit",
    async (concurrency) => {
      const result = await runLifecycle("drain", concurrency);
      expect(result).toMatchObject({
        fulfilled: 4,
        rejected: ["Expected render failure"],
        identicalPngs: true,
        sameClosePromise: true,
        terminated: concurrency === 1 ? 0 : concurrency,
        messagePorts: 0,
        rejectedAfterClose: true,
        coverageRejected: true,
      });
    },
    15_000,
  );

  it("replaces a worker lost during close only to finish accepted queued renders", async () => {
    const result = await runLifecycle("worker-exit", 2);
    expect(result).toMatchObject({
      fulfilled: 4,
      identicalPngs: true,
      terminated: 2,
      messagePorts: 0,
    });
    expect(result.rejected).toEqual([expect.stringContaining("render worker exited with code")]);
  }, 15_000);

  it("lets existing callers exit naturally with an unused idle worker", async () => {
    expect(await runLifecycle("idle", 2)).toMatchObject({ completed: true, terminated: 0 });
  }, 15_000);

  it("closes a pool that has never rendered a tile", async () => {
    expect(await runLifecycle("unused", 2)).toMatchObject({
      completed: true,
      terminated: 2,
      messagePorts: 0,
    });
  }, 15_000);

  it("rejects invalid render concurrency before reading the world", async () => {
    await expect(
      openBedrockWorld({ directory: "/not-read", renderConcurrency: 0 }),
    ).rejects.toThrow("renderConcurrency must be a positive integer");
  });

  it("loads neighboring biome records for a seam-free tile render", async () => {
    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-halo-"));
    try {
      const databaseDirectory = join(worldDirectory, "db");
      await mkdir(databaseDirectory);
      await writeFixtureManifest(worldDirectory);
      const subchunk = singleBlockSubchunk(15, 0, 4, 15, 0);
      await writeFile(
        join(databaseDirectory, "000001.log"),
        levelDbLog([subchunk, data2DChunk(15, 0, 1), data2DChunk(16, 0, 6)]),
      );

      const world = await openBedrockWorld({ directory: worldDirectory });
      const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
      const pixelOffset = 255 * 4;
      expect(tile.rgba[pixelOffset]).toBeLessThan(145);
      expect(tile.rgba[pixelOffset]).toBeGreaterThan(107);
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  });

  it("maps a solid-color detailed negative tile to its parent index tile", async () => {
    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-detail-"));
    try {
      const databaseDirectory = join(worldDirectory, "db");
      await mkdir(databaseDirectory);
      await writeFixtureManifest(worldDirectory);
      await writeFile(
        join(databaseDirectory, "000001.log"),
        levelDbLog([singleBlockSubchunk(-16, 0, 4, 0, 0)]),
      );

      const world = await openBedrockWorld({ directory: worldDirectory });
      const tile = await world.renderTile({ dimension: "overworld", z: 2, x: -4, y: 0 });
      const colors = new Set<string>();
      for (let pixelZ = 0; pixelZ < 4; pixelZ += 1) {
        for (let pixelX = 0; pixelX < 4; pixelX += 1) {
          const offset = (pixelZ * 256 + pixelX) * 4;
          colors.add(Array.from(tile.rgba.slice(offset, offset + 4)).join(","));
        }
      }

      expect(tile.bounds).toEqual({ minX: -256, minZ: 0, maxX: -192, maxZ: 64 });
      expect(colors).toEqual(new Set(["107,120,42,255"]));
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  });

  it("loads shadow input from the neighboring index tile", async () => {
    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-shadow-halo-"));
    try {
      const databaseDirectory = join(worldDirectory, "db");
      await mkdir(databaseDirectory);
      await writeFixtureManifest(worldDirectory);
      await writeFile(
        join(databaseDirectory, "000001.log"),
        levelDbLog([singleBlockSubchunk(0, 0, 4, 0, 1), singleBlockSubchunk(-1, 0, 5, 15, 0, 1)]),
      );

      const world = await openBedrockWorld({ directory: worldDirectory });
      const coordinates = { dimension: "overworld" as const, z: 2, x: 0, y: 0 };
      const [lit, shadowed] = await Promise.all([
        world.renderTile(coordinates, { shadows: false }),
        world.renderTile(coordinates),
      ]);
      const receiverOffsets = Array.from(
        { length: 16 },
        (_, index) => ((4 + Math.floor(index / 4)) * 256 + (index % 4)) * 4,
      );

      expect(receiverOffsets.some((offset) => shadowed.rgba[offset] !== lit.rgba[offset])).toBe(
        true,
      );
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    { label: "an unbounded", renderCacheMiB: 256, renderConcurrency: 1 },
    { label: "an evicting", renderCacheMiB: 0.01, renderConcurrency: 1 },
  ])(
    "renders identical pixels with $label render cache",
    async ({ renderCacheMiB, renderConcurrency }) => {
      const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-render-cache-"));
      try {
        const databaseDirectory = join(worldDirectory, "db");
        await mkdir(databaseDirectory);
        const entries = [];
        for (const [chunkX, chunkZ] of [
          [-17, -3],
          [-2, 0],
          [-1, 0],
          [0, 0],
          [0, 1],
          [3, 4],
          [15, 15],
          [16, 2],
        ] as const) {
          const height = 4 + ((chunkX * 7 + chunkZ * 3) & 3);
          entries.push(singleBlockSubchunk(chunkX, chunkZ, height, chunkX & 15, chunkZ & 15));
          entries.push(data2DChunk(chunkX, chunkZ, 1 + (chunkX & 3)));
        }
        await writeFixtureManifest(worldDirectory);
        await writeFile(join(databaseDirectory, "000001.log"), levelDbLog(entries));
        const tiles = [
          { z: 0, x: 0, y: 0 },
          { z: 0, x: -1, y: 0 },
          { z: 1, x: 0, y: 0 },
          { z: 1, x: 1, y: 1 },
          { z: 2, x: 0, y: 0 },
          { z: 2, x: 3, y: 2 },
          { z: 2, x: -1, y: -1 },
          { z: 0, x: 0, y: 0 },
        ].map((tile) => ({ dimension: "overworld" as const, ...tile }));
        const renderAll = async (cacheMiB: number, concurrency: number) => {
          const world = await openBedrockWorld({
            directory: worldDirectory,
            renderCacheMiB: cacheMiB,
            renderConcurrency: concurrency,
          });
          try {
            const rendered = [];
            for (const coordinates of tiles) {
              rendered.push(await world.renderTile(coordinates, { biomeBlendRadius: 2 }));
            }
            return rendered.map((tile) => Buffer.from(tile.rgba).toString("base64"));
          } finally {
            await world.close();
          }
        };

        expect(await renderAll(renderCacheMiB, renderConcurrency)).toEqual(await renderAll(0, 1));
      } finally {
        await rm(worldDirectory, { recursive: true, force: true });
      }
    },
    15_000,
  );
});

interface LifecycleResult {
  readonly fulfilled?: number;
  readonly rejected?: readonly string[];
  readonly rejectedNames?: readonly string[];
  readonly failure?: string;
}

async function runLifecycle(
  scenario: string,
  concurrency: number,
  script?: string,
): Promise<LifecycleResult> {
  const directory = await mkdtemp(join(tmpdir(), "mapelix-lifecycle-"));
  try {
    await mkdir(join(directory, "db"));
    await writeFixtureManifest(directory);
    await writeFile(
      join(directory, "db", "000001.log"),
      levelDbLog([singleBlockSubchunk(0, 0, 4, 0, 0), data2DChunk(0, 0, 1)]),
    );
    const { stdout } = await run(
      process.execPath,
      [
        script === undefined
          ? lifecycleScript
          : fileURLToPath(new URL(`../test/${script}`, import.meta.url)),
        directory,
        scenario,
        String(concurrency),
      ],
      { timeout: 10_000 },
    );
    return JSON.parse(stdout) as LifecycleResult;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function int32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function fixed64(value: bigint): number[] {
  return Array.from({ length: 8 }, (_, index) => Number((value >> BigInt(index * 8)) & 0xffn));
}

function varint(value: number): number[] {
  const result: number[] = [];
  while (value >= 0x80) {
    result.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  result.push(value);
  return result;
}

function levelDbLog(entries: Array<{ key: Uint8Array; value: Uint8Array }>): Uint8Array {
  const batch = new Uint8Array([
    ...fixed64(1n),
    entries.length & 0xff,
    0,
    0,
    0,
    ...entries.flatMap(({ key, value }) => [
      1,
      ...varint(key.byteLength),
      ...key,
      ...varint(value.byteLength),
      ...value,
    ]),
  ]);
  return fixtureLog([batch]);
}

function singleBlockSubchunk(
  chunkX: number,
  chunkZ: number,
  subchunkY: number,
  localX: number,
  localZ: number,
  localY = 15,
) {
  const words = new Uint8Array(Math.ceil(4096 / 32) * 4);
  const blockIndex = localX * 256 + localZ * 16 + localY;
  words[Math.floor(blockIndex / 8)]! |= 1 << (blockIndex % 8);
  const palette = new Uint8Array([
    10,
    0,
    0,
    ...nbtString("name", "minecraft:air"),
    0,
    10,
    0,
    0,
    ...nbtString("name", "minecraft:grass_block"),
    0,
  ]);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2f, subchunkY & 0xff]),
    value: new Uint8Array([9, 1, subchunkY & 0xff, 2, ...words, 2, 0, 0, 0, ...palette]),
  };
}

function nbtString(name: string, value: string): number[] {
  const encodedName = Array.from(new TextEncoder().encode(name));
  const encodedValue = Array.from(new TextEncoder().encode(value));
  return [8, encodedName.length, 0, ...encodedName, encodedValue.length, 0, ...encodedValue];
}

function data2DChunk(chunkX: number, chunkZ: number, biomeId: number) {
  const value = new Uint8Array(768);
  value.fill(biomeId, 512);
  return {
    key: new Uint8Array([...int32(chunkX), ...int32(chunkZ), 0x2d]),
    value,
  };
}
