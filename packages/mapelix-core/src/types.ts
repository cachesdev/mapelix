import type {
  CloseWorldOptions,
  RenderedTile,
  RenderTileOptions,
  TileCoordinates,
  TileCoverage,
  Dimension,
  SurfaceStoreStats,
} from "@mapelix/prototype";

export type {
  Dimension,
  RenderedTile,
  TileCoordinates,
  TileCoverage,
  CloseWorldOptions,
  SurfaceStoreStats,
};

export type MapAppearance = "modern" | "reference";

export interface MapRenderOptions extends Omit<RenderTileOptions, "surfaceRange" | "surfaceStyle"> {
  /** Highest included block; defaults to the selected dimension's surface profile. */
  readonly topY?: number;
  /** Recent block colors and ground cover by default; reference preserves batch-1 appearance. */
  readonly appearance?: MapAppearance;
}

export interface MapWorld {
  renderTile(coordinates: TileCoordinates, options?: MapRenderOptions): Promise<RenderedTile>;
  getTileCoverage(dimension: Dimension): readonly TileCoverage[];
  /** Chunk content fingerprints keyed `x,z`; required for incremental batch updates. */
  getChunkFingerprints?(dimension: Dimension): ReadonlyMap<string, string>;
  /** Counters of the optional on-disk chunk surface store; final once `close()` resolves. */
  getSurfaceCacheStats?(): SurfaceStoreStats | undefined;
  close(options?: CloseWorldOptions): Promise<void>;
}
