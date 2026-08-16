export const TILE_SIZE = 256;

export type Dimension = "overworld" | "nether" | "the-end";

export interface TileCoordinates {
  readonly dimension: Dimension;
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

export interface BlockBounds {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface RenderedTile {
  readonly coordinates: TileCoordinates;
  readonly bounds: BlockBounds;
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly png: Uint8Array;
}

export interface SurfaceBlock {
  readonly name: string;
  readonly y: number;
  /** Numeric Bedrock biome identifier when the world stores a compatible biome record. */
  readonly biomeId?: number;
  /** Number of visible water blocks above the first non-water block. */
  readonly fluidDepth?: number;
  /** First non-water block below a water surface, used for visual compositing. */
  readonly underwaterName?: string;
}

export type SurfaceSamples = ReadonlyArray<SurfaceBlock | undefined>;

export function tileBounds(coordinates: TileCoordinates): BlockBounds {
  if (coordinates.z !== 0) {
    throw new RangeError(`Mapelix prototype supports only zoom 0, received ${coordinates.z}`);
  }

  const minX = coordinates.x * TILE_SIZE;
  const minZ = coordinates.y * TILE_SIZE;
  return {
    minX,
    minZ,
    maxX: minX + TILE_SIZE,
    maxZ: minZ + TILE_SIZE,
  };
}

export function floorDiv(value: number, divisor: number): number {
  if (!Number.isInteger(value) || !Number.isInteger(divisor) || divisor <= 0) {
    throw new RangeError("floorDiv expects an integer value and a positive integer divisor");
  }
  return Math.floor(value / divisor);
}
