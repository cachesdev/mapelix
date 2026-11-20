import { describe, expect, it } from "vitest";

import { assertSurfaceRange } from "./surface-range.js";

describe("opt-in surface range validation", () => {
  it.each([
    { minY: 0, maxY: 128, topY: 90.5 },
    { minY: 1, maxY: 128, topY: 90 },
    { minY: 0, maxY: 129, topY: 90 },
    { minY: 0, maxY: 128, topY: 128 },
    { minY: 0, maxY: 128, topY: -1 },
    { minY: 0, maxY: 0, topY: 0 },
    { minY: -64, maxY: 512, topY: 90 },
    { minY: 0, maxY: Infinity, topY: 90 },
  ])("rejects an invalid or unbounded section range $minY..$maxY at $topY", (range) => {
    expect(() => assertSurfaceRange(range)).toThrow(RangeError);
  });
});
