export const TILE_SIZE = 256;
export const MAX_NATIVE_ZOOM = 3;

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
  const blockSpan = tileBlockSpan(coordinates.z);

  const minX = coordinates.x * blockSpan;
  const minZ = coordinates.y * blockSpan;
  return {
    minX,
    minZ,
    maxX: minX + blockSpan,
    maxZ: minZ + blockSpan,
  };
}

export function pixelsPerBlockAtZoom(zoom: number): number {
  if (!Number.isSafeInteger(zoom) || zoom < 0 || zoom > MAX_NATIVE_ZOOM) {
    throw new RangeError(
      `Mapelix prototype supports native zoom from 0 through ${MAX_NATIVE_ZOOM}, received ${zoom}`,
    );
  }
  return 2 ** zoom;
}

export function tileBlockSpan(zoom: number): number {
  return TILE_SIZE / pixelsPerBlockAtZoom(zoom);
}

export function floorDiv(value: number, divisor: number): number {
  if (!Number.isInteger(value) || !Number.isInteger(divisor) || divisor <= 0) {
    throw new RangeError("floorDiv expects an integer value and a positive integer divisor");
  }
  return Math.floor(value / divisor);
}
