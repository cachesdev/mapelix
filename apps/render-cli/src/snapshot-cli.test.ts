import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../../packages/mapelix-scene-prototype/test/dimension-fixture.js";
import { validateSnapshot } from "@mapelix/core/node/snapshot";

const run = promisify(execFile);
const executable = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const readonlyProbe = fileURLToPath(
  new URL("../../../packages/mapelix-core/test/snapshot-process.mjs", import.meta.url),
);
const signalProbe = fileURLToPath(new URL("../test/snapshot-signal.mjs", import.meta.url));
let world: string;
beforeEach(async () => {
  world = await mkdtemp(join(tmpdir(), "mapelix-validation-cli-"));
  await writeFixtureWorld(world, [sectionRecord(0, 0, 0, 4, "minecraft:stone")]);
});
afterEach(async () => {
  await rm(world, { recursive: true, force: true });
});

describe("mapelix-render validate", () => {
  it("prints one versioned JSON result matching the API without an output directory", async () => {
    const { stdout, stderr } = await run(process.execPath, [
      executable,
      "validate",
      "--world",
      world,
    ]);
    expect(stderr).toBe("");
    expect(stdout.trim().split("\n")).toHaveLength(1);
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      format: "mapelix-snapshot-validation",
      schemaVersion: 1,
      valid: true,
      revision: (await validateSnapshot(world)).revision,
      activeTables: 0,
      selectedJournals: 1,
      ignoredTables: 0,
      errors: [],
    });
    expect(await readdir(world)).toEqual(expect.arrayContaining(["db", "levelname.txt"]));
  });

  it.each(["CURRENT", "000001.log"])(
    "returns JSON and exit 1 for invalid %s, with diagnostics on stderr",
    async (name) => {
      await writeFile(join(world, "db", name), "invalid");
      const error = (await run(process.execPath, [executable, "validate", "--world", world]).catch(
        (cause: unknown) => cause,
      )) as { code: number; stdout: string; stderr: string };
      expect(error.code).toBe(1);
      const code = name === "CURRENT" ? "CURRENT_INVALID" : "REQUIRED_LOG_INVALID";
      expect(JSON.parse(error.stdout)).toMatchObject({
        valid: false,
        revision: null,
        errors: [{ code, file: `db/${name}` }],
      });
      expect(error.stderr).toContain(code);
    },
  );

  it.each([
    [],
    ["--world", "x", "--output", "out"],
    ["--world", "x", "--timeout-seconds", "0"],
    ["--world", "x", "--max-decoded-block-bytes", "NaN"],
  ])("uses exit 2 and versioned JSON for invalid arguments %j", async (...parts) => {
    const args = parts.flat() as string[];
    const error = (await run(process.execPath, [executable, "validate", ...args]).catch(
      (cause: unknown) => cause,
    )) as { code: number; stdout: string; stderr: string };
    expect(error.code).toBe(2);
    expect(JSON.parse(error.stdout)).toMatchObject({
      valid: false,
      errors: [{ code: "VALIDATION_OPTIONS_INVALID" }],
    });
    expect(error.stderr).toContain("VALIDATION_OPTIONS_INVALID");
  });

  it("reports a configured limit with exit 1", async () => {
    const error = (await run(process.execPath, [
      executable,
      "validate",
      "--world",
      world,
      "--max-input-file-bytes",
      "1",
    ]).catch((cause: unknown) => cause)) as { code: number; stdout: string };
    expect(error.code).toBe(1);
    expect(JSON.parse(error.stdout)).toMatchObject({
      valid: false,
      errors: [{ code: "SNAPSHOT_LIMIT_EXCEEDED" }],
    });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("settles %s with JSON and exit %i", async (signal, code) => {
    const error = (await run(process.execPath, [
      signalProbe,
      executable,
      signal,
      "validate",
      "--world",
      world,
    ]).catch((cause: unknown) => cause)) as { code: number; stdout: string; stderr: string };
    expect(error.code).toBe(code);
    expect(JSON.parse(error.stdout)).toMatchObject({
      valid: false,
      errors: [{ code: "VALIDATION_CANCELLED" }],
    });
    expect(error.stderr).toContain("VALIDATION_CANCELLED");
  });

  it("runs without rendering or filesystem mutation and never opens the inactive table", async () => {
    const inactive = join(world, "db", "038514.ldb");
    await writeFile(inactive, new Uint8Array(79383));
    const before = await stat(inactive);
    const bytes = await readFile(inactive);
    const { stdout, stderr } = await run(process.execPath, [
      readonlyProbe,
      executable,
      world,
      "cli-readonly",
    ]);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({ valid: true, ignoredTables: 1 });
    expect(await readFile(inactive)).toEqual(bytes);
    const after = await stat(inactive);
    expect([after.mode, after.mtimeMs, after.ctimeMs]).toEqual([
      before.mode,
      before.mtimeMs,
      before.ctimeMs,
    ]);
  });

  it("prints validation help and preserves the existing rendering help", async () => {
    const help = await run(process.execPath, [executable, "validate", "--help"]);
    expect(help.stdout).toContain("Usage: mapelix-render validate");
    expect(help.stderr).toBe("");
    const render = await run(process.execPath, [executable, "--help"]);
    expect(render.stdout).toContain("--output");
    expect(render.stderr).toBe("");
  });
});
