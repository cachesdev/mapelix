/** Browser-safe profile metadata and byte-oriented public types. */
export {
  MAP_TILE_SIZE,
  MIN_MAP_ZOOM,
  MAX_MAP_ZOOM,
  DEFAULT_MAP_ZOOMS,
  mapTileBounds,
  mapTileAncestor,
  mapPixelsPerBlock,
} from "./tile-grid.js";
export {
  DIMENSION_PROFILES,
  surfaceProfile,
  type DimensionProfile,
  type SurfaceProfile,
} from "./surface-profiles.js";
export type {
  Dimension,
  RenderedTile,
  TileCoordinates,
  TileCoverage,
  CloseWorldOptions,
  MapRenderOptions,
  MapAppearance,
  MapWorld,
} from "./types.js";
