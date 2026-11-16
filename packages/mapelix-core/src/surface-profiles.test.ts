import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { surfaceProfile } from "./surface-profiles.js";
import type { Dimension } from "./types.js";

describe("classic surface profiles", () => {
  it.each([
    ["overworld", -64, 320, 319],
    ["nether", 0, 128, 90],
    ["the-end", 0, 256, 255],
  ] as const)("uses %s bounds with an included default top", (dimension, minY, maxY, topY) => {
    expect(surfaceProfile(dimension)).toMatchObject({ dimension, minY, maxY, topY });
    expect(surfaceProfile(dimension, minY).topY).toBe(minY);
    expect(surfaceProfile(dimension, maxY - 1).topY).toBe(maxY - 1);
    expect(() => surfaceProfile(dimension, minY - 1)).toThrow(RangeError);
    expect(() => surfaceProfile(dimension, maxY)).toThrow(RangeError);
  });

  it.each([90.5, NaN, Infinity, -Infinity, null, "90"])("rejects a noninteger cut %s", (topY) => {
    expect(() => surfaceProfile("nether", topY as number)).toThrow(RangeError);
  });

  it.each(["end", "moon", "toString", 1, null])(
    "rejects an unsupported dimension %s",
    (dimension) => {
      expect(() => surfaceProfile(dimension as Dimension)).toThrow(RangeError);
    },
  );

  it("keeps the public profile entry importable without Node builtins", async () => {
    const script = fileURLToPath(new URL("../test/portable-entry.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 5000 });
    expect(JSON.parse(stdout)).toMatchObject({
      dimension: "nether",
      topY: 90,
      appearanceEntries: 1276,
    });
  });
});
