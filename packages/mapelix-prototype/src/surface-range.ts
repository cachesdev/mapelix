/** Full dimension bounds and its highest included surface block. */
export interface SurfaceRange {
  readonly minY: number;
  /** Exclusive physical upper bound, independent of the visible top-Y cut. */
  readonly maxY: number;
  readonly topY: number;
}

export function assertSurfaceRange(range: SurfaceRange | undefined): void {
  if (range === undefined) return;
  if (
    !Number.isSafeInteger(range.minY) ||
    !Number.isSafeInteger(range.maxY) ||
    !Number.isSafeInteger(range.topY) ||
    range.minY % 16 !== 0 ||
    range.maxY % 16 !== 0 ||
    range.maxY <= range.minY ||
    range.maxY - range.minY > 384 ||
    range.topY < range.minY ||
    range.topY >= range.maxY
  ) {
    throw new RangeError(
      "Surface bounds must span 1..24 aligned sections and include an integer topY within minY..maxY-1",
    );
  }
}
