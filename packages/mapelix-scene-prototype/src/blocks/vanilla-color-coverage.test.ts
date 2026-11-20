import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { BEDROCK_BLOCK_COLORS } from "./bedrock-colors.js";
import { resolveBlockAppearance } from "./block-appearance.js";

describe("complete vanilla gameplay color coverage", () => {
  it("keeps gray fallback only for Education and explicitly unavailable registry entries", async () => {
    const report = JSON.parse(
      await readFile(
        new URL("../../../../docs/block-colors-coverage.json", import.meta.url),
        "utf8",
      ),
    ) as { total: number; unresolved: { block: string; reason: string }[] };
    const names = new Set([
      ...Object.keys(BEDROCK_BLOCK_COLORS),
      ...report.unresolved.map((entry) => entry.block),
    ]);
    expect(names.size).toBe(report.total);
    expect(names.size).toBe(1466);
    const education =
      /^(?:element_\d+|hard_.*|chemical_heat|compound_creator|element_constructor|lab_table|material_reducer)$/;
    const gray: string[] = [];
    for (const name of names) {
      if (education.test(name)) continue;
      const appearance = resolveBlockAppearance(`minecraft:${name}`, {});
      if (
        appearance.shape.kind !== "empty" &&
        appearance.top === 0xd8d8d8 &&
        appearance.side === 0xd8d8d8
      )
        gray.push(name);
    }
    expect(gray.sort((a, b) => a.localeCompare(b))).toEqual(["disc_press", "icicle", "unknown"]);
    for (const name of gray)
      expect(report.unresolved.some((entry) => entry.block === name)).toBe(true);
  });
});
