import type {
  CloseWorldOptions,
  RenderedTile,
  RenderTileOptions,
  TileCoordinates,
  TileCoverage,
  Dimension,
} from "@mapelix/prototype";

export type { Dimension, RenderedTile, TileCoordinates, TileCoverage, CloseWorldOptions };

export interface MapRenderOptions extends Omit<RenderTileOptions, "surfaceRange"> {
  /** Highest included block; defaults to the selected dimension's surface profile. */
  readonly topY?: number;
}

export interface MapWorld {
  renderTile(coordinates: TileCoordinates, options?: MapRenderOptions): Promise<RenderedTile>;
  getTileCoverage(dimension: Dimension): readonly TileCoverage[];
  close(options?: CloseWorldOptions): Promise<void>;
}
