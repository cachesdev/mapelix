import type { TileCoordinates } from "./types.js";

export const MAP_TILE_SIZE = 256;
export const MIN_MAP_ZOOM = -4;
/** The explicit +3 compatibility level is retained; classic exports default to +2. */
export const MAX_MAP_ZOOM = 3;
export const DEFAULT_MAP_ZOOMS: readonly number[] = Object.freeze([-4, -3, -2, -1, 0, 1, 2]);

export function mapPixelsPerBlock(zoom: number): number {
  if (!Number.isSafeInteger(zoom) || zoom < MIN_MAP_ZOOM || zoom > MAX_MAP_ZOOM) {
    throw new RangeError(`Map zoom must be an integer within ${MIN_MAP_ZOOM}..${MAX_MAP_ZOOM}`);
  }
  return 2 ** zoom;
}

/** XYZ uses X east and Y south (Minecraft Z), with exclusive maximum block bounds. */
export function mapTileBounds(tile: TileCoordinates): {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
} {
  if (tile.dimension !== "overworld" && tile.dimension !== "nether" && tile.dimension !== "the-end")
    throw new RangeError("Unsupported map dimension");
  const span = MAP_TILE_SIZE / mapPixelsPerBlock(tile.z);
  if (
    ![tile.x, tile.y].every(
      (value) =>
        Number.isSafeInteger(value) &&
        Number.isSafeInteger(value * span) &&
        Number.isSafeInteger((value + 1) * span),
    )
  ) {
    throw new RangeError("Tile coordinates exceed the safe integer grid");
  }
  return {
    minX: tile.x * span,
    minZ: tile.y * span,
    maxX: (tile.x + 1) * span,
    maxZ: (tile.y + 1) * span,
  };
}

/** Select an ancestor with floor division, including children west/north of the origin. */
export function mapTileAncestor(tile: TileCoordinates, zoom: number): TileCoordinates {
  mapTileBounds(tile);
  mapPixelsPerBlock(zoom);
  if (zoom > tile.z) throw new RangeError("An ancestor cannot have a finer zoom");
  const scale = 2 ** (tile.z - zoom);
  return {
    dimension: tile.dimension,
    z: zoom,
    x: Math.floor(tile.x / scale),
    y: Math.floor(tile.y / scale),
  };
}
