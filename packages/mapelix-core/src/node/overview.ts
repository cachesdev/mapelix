import { encodePng } from "@mapelix/prototype/png";

import { OverviewAccumulator, type OverviewSourceTile } from "../overview.js";
import { MAP_TILE_SIZE, mapTileBounds } from "../tile-grid.js";
import type { RenderedTile, TileCoordinates } from "../types.js";

export type { OverviewSourceTile };

/** Streams native zoom-0 RGBA into one transparent overview tile; missing sources are empty. */
export async function createOverviewTile(
  coordinates: TileCoordinates,
  sources: Iterable<OverviewSourceTile> | AsyncIterable<OverviewSourceTile>,
  signal?: AbortSignal,
): Promise<RenderedTile> {
  signal?.throwIfAborted();
  const accumulator = new OverviewAccumulator(coordinates);
  for await (const source of sources) {
    signal?.throwIfAborted();
    accumulator.add(source);
  }
  signal?.throwIfAborted();
  const rgba = accumulator.finish();
  const png = encodePng(rgba, MAP_TILE_SIZE, MAP_TILE_SIZE);
  signal?.throwIfAborted();
  return {
    coordinates: { ...accumulator.coordinates },
    bounds: mapTileBounds(accumulator.coordinates),
    width: MAP_TILE_SIZE,
    height: MAP_TILE_SIZE,
    rgba,
    png,
  };
}
