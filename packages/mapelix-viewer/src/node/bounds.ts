/** A rectangle of blocks, both ends included. */
export interface BlockBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Bedrock's world border, in blocks from the origin. */
export const WORLD_LIMIT = 30_000_000;

/** Checks host-given bounds: whole blocks, minimum before maximum, inside the world border. */
export function checkBounds(bounds: BlockBounds): BlockBounds {
  const values = [bounds.minX, bounds.minZ, bounds.maxX, bounds.maxZ];
  if (!values.every((value) => Number.isSafeInteger(value) && Math.abs(value) <= WORLD_LIMIT))
    throw new RangeError("bounds must be whole block numbers inside the world border");
  if (bounds.minX > bounds.maxX || bounds.minZ > bounds.maxZ)
    throw new RangeError("bounds minimum exceeds maximum");
  return { minX: bounds.minX, minZ: bounds.minZ, maxX: bounds.maxX, maxZ: bounds.maxZ };
}
