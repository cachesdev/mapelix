import { describe, expect, it } from "vitest";

import type { TileCoordinates } from "../../types.js";
import { nextJob, spatialBands } from "./executor.js";

const tile = (z: number, x: number, y: number): TileCoordinates => ({
  dimension: "overworld",
  z,
  x,
  y,
});

describe("spatialBands", () => {
  it("groups the native zooms of each zoom-0 area, north to south and west to east", () => {
    const jobs = [tile(2, 7, 0), tile(0, 1, 0), tile(1, 0, 2), tile(0, 0, 1), tile(2, 0, 0)];
    const [band] = spatialBands(jobs, 1);

    expect(band).toEqual([
      tile(2, 0, 0),
      tile(0, 1, 0),
      tile(2, 7, 0),
      tile(0, 0, 1),
      tile(1, 0, 2),
    ]);
  });

  it("splits contiguous bands and lets an idle lane take the end of the largest band", () => {
    const jobs = Array.from({ length: 5 }, (_, x) => tile(0, x, 0));
    const bands = spatialBands(jobs, 2);

    expect(bands).toEqual([jobs.slice(0, 2), jobs.slice(2)]);
    expect([nextJob(bands, 0), nextJob(bands, 0), nextJob(bands, 0)]).toEqual([
      jobs[0],
      jobs[1],
      jobs[4],
    ]);
    expect([nextJob(bands, 1), nextJob(bands, 1), nextJob(bands, 1)]).toEqual([
      jobs[2],
      jobs[3],
      undefined,
    ]);
  });
});
