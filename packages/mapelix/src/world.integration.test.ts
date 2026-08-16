import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { openBedrockWorld } from "./node-world.js";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("../test/fixtures/2000world.mcworld", import.meta.url));
const fixtureHash = "9f102af4e5ba617820c8da723956745450b4ebf7c31d676d8db038038367b35b";

describe("real Bedrock world", () => {
  it("renders visually useful terrain from table and log records", async () => {
    const archive = await readFile(fixture);
    expect(createHash("sha256").update(archive).digest("hex")).toBe(fixtureHash);

    const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-fixture-"));
    try {
      await run("unzip", ["-qq", fixture, "-d", worldDirectory]);
      const world = await openBedrockWorld({ directory: worldDirectory });
      const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });

      let opaquePixels = 0;
      const opaqueColors = new Set<string>();
      for (let offset = 0; offset < tile.rgba.length; offset += 4) {
        const alpha = tile.rgba[offset + 3];
        if (alpha !== undefined && alpha > 0) {
          opaquePixels += 1;
          opaqueColors.add(Array.from(tile.rgba.slice(offset, offset + 4)).join(","));
        }
      }

      expect(tile.width).toBe(256);
      expect(tile.height).toBe(256);
      expect(Array.from(tile.png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(opaquePixels).toBeGreaterThan(256);
      expect(opaqueColors.size).toBeGreaterThan(4);
    } finally {
      await rm(worldDirectory, { recursive: true, force: true });
    }
  }, 30_000);
});
