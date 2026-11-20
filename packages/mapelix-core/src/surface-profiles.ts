import type { Dimension } from "@mapelix/prototype";

export interface DimensionProfile {
  readonly dimension: Dimension;
  readonly storageId: number;
  readonly minY: number;
  /** Exclusive physical upper bound; not the visible top-Y cut. */
  readonly maxY: number;
  /** Highest included surface block used when no topY is supplied. */
  readonly defaultTopY: number;
}

export interface SurfaceProfile extends DimensionProfile {
  /** Highest included block, with no section alignment or rounding. */
  readonly topY: number;
}

/** Classic 2D profiles, independent of 3D geometry and camera defaults. */
export const DIMENSION_PROFILES: Readonly<Record<Dimension, DimensionProfile>> = Object.freeze({
  overworld: Object.freeze({
    dimension: "overworld",
    storageId: 0,
    minY: -64,
    maxY: 320,
    defaultTopY: 319,
  }),
  nether: Object.freeze({ dimension: "nether", storageId: 1, minY: 0, maxY: 128, defaultTopY: 90 }),
  "the-end": Object.freeze({
    dimension: "the-end",
    storageId: 2,
    minY: 0,
    maxY: 256,
    defaultTopY: 255,
  }),
});

export function surfaceProfile(dimension: Dimension = "overworld", topY?: number): SurfaceProfile {
  if (dimension !== "overworld" && dimension !== "nether" && dimension !== "the-end") {
    throw new RangeError("Unsupported surface dimension");
  }
  const profile = DIMENSION_PROFILES[dimension];
  const includedTop = topY === undefined ? profile.defaultTopY : topY;
  if (
    !Number.isSafeInteger(includedTop) ||
    includedTop < profile.minY ||
    includedTop >= profile.maxY
  ) {
    throw new RangeError(
      `topY must be an integer within ${profile.minY}..${profile.maxY - 1} for ${dimension}`,
    );
  }
  return Object.freeze({ ...profile, topY: includedTop });
}
