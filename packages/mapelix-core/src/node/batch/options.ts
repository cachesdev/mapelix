import { resolve } from "node:path";

import { surfaceProfile } from "../../surface-profiles.js";
import { DEFAULT_MAP_ZOOMS, mapPixelsPerBlock } from "../../tile-grid.js";
import type { Dimension } from "../../types.js";
import type { BatchLimits, BatchOptions, NormalizedBatch } from "./types.js";

export const DEFAULT_BATCH_LIMITS: BatchLimits = Object.freeze({
  workers: 2,
  maxPending: 2,
  maxTiles: 10_000,
  maxOutputBytes: 1024 ** 3,
  maxInputFileBytes: 256 * 1024 ** 2,
  timeoutMs: 300_000,
  memoryBudgetMiB: 2048,
});

export function positiveInteger(
  name: string,
  value: number,
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`${name} must be an integer within 1..${max}`);
  }
  return value;
}

export function normalizeBatch(options: BatchOptions): NormalizedBatch {
  if (!options.world || !options.output) throw new TypeError("world and output are required");
  const dimensions = [
    ...new Set(
      (options.dimensions ?? ["overworld", "nether", "the-end"]).map((dimension): Dimension => {
        if (dimension === "end") return "the-end";
        surfaceProfile(dimension);
        return dimension;
      }),
    ),
  ].sort();
  if (dimensions.length === 0) throw new RangeError("At least one dimension is required");
  const profiles = dimensions.map((dimension) => surfaceProfile(dimension, options.topY));
  const zooms = [...new Set(options.zooms ?? DEFAULT_MAP_ZOOMS)].sort((a, b) => a - b);
  if (zooms.length === 0) throw new RangeError("At least one map zoom is required");
  zooms.forEach(mapPixelsPerBlock);
  const limits = { ...DEFAULT_BATCH_LIMITS, ...options.limits };
  limits.maxPending = options.limits?.maxPending ?? limits.workers;
  for (const [name, value] of Object.entries(limits)) positiveInteger(name, value);
  positiveInteger("workers", limits.workers, 16);
  positiveInteger("maxPending", limits.maxPending, 1024);
  positiveInteger("timeoutMs", limits.timeoutMs, 2_147_483_647);
  const appearance = options.appearance ?? "modern";
  if (appearance !== "modern" && appearance !== "reference")
    throw new RangeError("Unsupported appearance");
  const shadows = options.shadows ?? "opacity";
  if (shadows !== "opacity" && shadows !== "off")
    throw new RangeError("shadows must be opacity or off");
  const biomeBlendRadius = options.biomeBlendRadius ?? 0;
  if (!Number.isSafeInteger(biomeBlendRadius) || biomeBlendRadius < 0 || biomeBlendRadius > 16) {
    throw new RangeError("biomeBlendRadius must be an integer within 0..16");
  }
  const bounds = options.bounds ?? null;
  if (
    bounds !== null &&
    ([bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ].some(
      (n) => !Number.isSafeInteger(n) || Math.abs(n) > 30_000_000,
    ) ||
      bounds.minX >= bounds.maxX ||
      bounds.minZ >= bounds.maxZ)
  )
    throw new RangeError("bounds must be nonempty exclusive block bounds within +/-30000000");
  return {
    world: resolve(options.world),
    output: resolve(options.output),
    profiles,
    zooms,
    appearance,
    shadows,
    biomeBlendRadius,
    correctReferenceBugs: options.correctReferenceBugs ?? false,
    bounds,
    incremental: options.incremental ?? false,
    limits,
  };
}
