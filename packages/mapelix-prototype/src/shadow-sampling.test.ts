import { describe, expect, it } from "vitest";

import { sampleShadowPixels } from "./shadow-sampling.js";

describe("sampleShadowPixels", () => {
  it("matches uNmINeD's zoom-2 corner, edge, and interior gates", () => {
    const calls: string[] = [];
    const hits = new Set(["0,0", "1,0", "0,2", "1,2"]);

    sampleShadowPixels(4, (x, z) => {
      const coordinate = `${x},${z}`;
      calls.push(coordinate);
      return hits.has(coordinate);
    });

    expect(calls).toEqual(["0,0", "3,0", "0,3", "3,3", "1,0", "2,0", "0,1", "0,2", "1,2"]);
  });

  it("stops after four corner misses", () => {
    const calls: string[] = [];

    sampleShadowPixels(4, (x, z) => {
      calls.push(`${x},${z}`);
      return x === 1 && z === 1;
    });

    expect(calls).toEqual(["0,0", "3,0", "0,3", "3,3"]);
  });

  it("samples every pixel at factors one and two", () => {
    for (const size of [1, 2]) {
      const calls: string[] = [];
      sampleShadowPixels(size, (x, z) => {
        calls.push(`${x},${z}`);
        return false;
      });
      expect(calls).toHaveLength(size * size);
    }
  });
});
