import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../packages/mapelix-scene-prototype/test/dimension-fixture.js";

import { parseBatchArguments } from "./arguments.js";

const run = promisify(execFile);
const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe("generic batch CLI", () => {
  it("parses repeated dimensions, exact cuts and bounds without host-specific state", () => {
    expect(
      parseBatchArguments([
        "--world",
        "snapshot",
        "--output",
        "out",
        "--dimension",
        "nether,end",
        "--dimension",
        "overworld",
        "--top-y=90",
        "--bounds=-64,-64,0,0",
        "--workers",
        "1",
        "--timeout-seconds",
        "20",
        "--shadows",
        "off",
        "--zooms=-4,-1",
        "--incremental",
      ]),
    ).toMatchObject({
      dimensions: ["nether", "end", "overworld"],
      topY: 90,
      bounds: { minX: -64, minZ: -64, maxX: 0, maxZ: 0 },
      limits: { workers: 1, timeoutMs: 20000 },
      shadows: "off",
      zooms: [-4, -1],
      incremental: true,
    });
    expect(parseBatchArguments(["--help"])).toBe("help");
  });

  it.each(
    [
      [],
      ["--world", "x"],
      ["--unknown"],
      ["--world", "x", "--output", "y", "--dimension", "../nether"],
      ["--world", "x", "--output", "y", "--dimension", "all,end"],
      ["--world", "x", "--output", "y", "--workers", "1.5"],
      ["--world", "x", "--output", "y", "--bounds=0,0,1"],
      ["--world", "x", "--output", "y", "--appearance", "textured"],
    ].map((args) => ({ args })),
  )("rejects invalid arguments $args", ({ args }) => {
    expect(() => parseBatchArguments(args)).toThrow();
  });

  it("prints help and exits naturally", async () => {
    const { stdout, stderr } = await run(process.execPath, [executable, "--help"], {
      timeout: 5000,
    });
    expect(stdout).toContain("Usage: mapelix-render");
    expect(stderr).toBe("");
  });

  it("handles SIGINT and a deadline with nonzero exit and owned-file cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapelix-cli-"));
    const world = join(root, "world");
    const output = join(root, "out");
    try {
      await writeFixtureWorld(
        world,
        Array.from({ length: 16 }, (_, index) =>
          sectionRecord(0, index * 16, 0, 4, "minecraft:stone"),
        ),
      );
      const args = [
        "--world",
        world,
        "--output",
        output,
        "--dimension",
        "overworld",
        "--zooms",
        "3",
        "--workers",
        "1",
      ];
      const script = fileURLToPath(new URL("../test/signal.mjs", import.meta.url));
      await expect(
        run(process.execPath, [script, executable, ...args], { timeout: 8000 }),
      ).rejects.toMatchObject({ code: 130, stderr: expect.stringContaining("AbortError") });
      expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
      await expect(
        run(process.execPath, [executable, ...args, "--timeout-seconds", "1"], { timeout: 8000 }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("TimeoutError") });
      expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
      await expect(readFile(join(output, "manifest.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("renders and exits without process.exit, and preserves output on an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "mapelix-cli-"));
    const world = join(root, "world");
    const output = join(root, "out");
    try {
      await writeFixtureWorld(world, [sectionRecord(1, 0, 0, 5, "minecraft:gold_block")]);
      const args = [
        executable,
        "--world",
        world,
        "--output",
        output,
        "--dimension",
        "nether",
        "--zooms",
        "0",
        "--workers",
        "1",
        "--shadows",
        "off",
      ];
      const { stdout, stderr } = await run(process.execPath, args, { timeout: 10000 });
      expect(stderr).toBe("");
      const value = JSON.parse(stdout) as { tiles: number; generation: string };
      expect(value.tiles).toBe(1);
      expect(value.generation).toMatch(/^[a-f0-9]{64}$/);
      const before = await readFile(join(output, "manifest.json"), "utf8");
      await expect(
        run(process.execPath, [...args, "--zooms", "0,1,2", "--max-tiles", "1"], {
          timeout: 10000,
        }),
      ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("maxTiles") });
      expect(await readFile(join(output, "manifest.json"), "utf8")).toBe(before);
      const overview = await run(process.execPath, [...args, "--zooms=-4,-1", "--max-tiles", "3"], {
        timeout: 10000,
      });
      expect(JSON.parse(overview.stdout)).toMatchObject({ tiles: 2 });
      const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
      expect(manifest.grid.zooms).toEqual([-4, -1]);
      expect(manifest.work).toMatchObject({ tileJobs: 3, temporaryTiles: 1 });
      expect((await readdir(output)).filter((name) => name.startsWith(".mapelix"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
