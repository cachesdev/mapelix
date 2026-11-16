import type { MapWorld, TileCoordinates } from "../../types.js";
import { mapTileAncestor, mapTileBounds } from "../../tile-grid.js";
import type { NormalizedBatch } from "./types.js";

export interface BatchTilePlan {
  readonly tiles: readonly TileCoordinates[];
  readonly temporary: readonly TileCoordinates[];
  readonly overviewSources: ReadonlyMap<string, readonly TileCoordinates[]>;
}

/** Plans published tiles and the zoom-0 source union, including whole overview bounds. */
export function createBatchPlan(
  world: Pick<MapWorld, "getTileCoverage">,
  batch: NormalizedBatch,
): BatchTilePlan {
  const tiles: TileCoordinates[] = [];
  const published = new Set<string>();
  const sourceCandidates: TileCoordinates[] = [];
  const temporary: TileCoordinates[] = [];
  const overviewZooms = batch.zooms.filter((z) => z < 0);
  function add(tile: TileCoordinates): void {
    const key = tilePath(tile);
    if (published.has(key)) return;
    if (tiles.length + temporary.length >= batch.limits.maxTiles)
      throw new RangeError(`Tile estimate exceeds maxTiles (${batch.limits.maxTiles})`);
    tiles.push(tile);
    published.add(key);
  }
  function intersects(tile: TileCoordinates): boolean {
    if (batch.bounds === null) return true;
    const bounds = mapTileBounds(tile);
    return (
      bounds.minX < batch.bounds.maxX &&
      bounds.maxX > batch.bounds.minX &&
      bounds.minZ < batch.bounds.maxZ &&
      bounds.maxZ > batch.bounds.minZ
    );
  }
  for (const { dimension } of batch.profiles) {
    const coverage = world.getTileCoverage(dimension);
    const seen = new Set<string>();
    for (const parent of coverage) {
      if (
        !Number.isSafeInteger(parent.x) ||
        !Number.isSafeInteger(parent.y) ||
        Math.abs(parent.x) > 2 ** 23 ||
        Math.abs(parent.y) > 2 ** 23
      ) {
        throw new RangeError("Invalid source tile coordinates");
      }
      const key = `${parent.x}/${parent.y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const source = { dimension, z: 0, x: parent.x, y: parent.y };
      let overviewSource = false;
      for (const z of batch.zooms) {
        if (z < 0) {
          const ancestor = mapTileAncestor(source, z);
          if (intersects(ancestor)) {
            add(ancestor);
            overviewSource = true;
          }
          continue;
        }
        const scale = 2 ** z;
        const span = 256 / scale;
        const minX = Math.max(
          parent.x * scale,
          batch.bounds === null ? -Infinity : Math.floor(batch.bounds.minX / span),
        );
        const maxX = Math.min(
          (parent.x + 1) * scale,
          batch.bounds === null ? Infinity : Math.ceil(batch.bounds.maxX / span),
        );
        const minY = Math.max(
          parent.y * scale,
          batch.bounds === null ? -Infinity : Math.floor(batch.bounds.minZ / span),
        );
        const maxY = Math.min(
          (parent.y + 1) * scale,
          batch.bounds === null ? Infinity : Math.ceil(batch.bounds.maxZ / span),
        );
        const count = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
        if (count > batch.limits.maxTiles - tiles.length - temporary.length) {
          throw new RangeError(`Tile estimate exceeds maxTiles (${batch.limits.maxTiles})`);
        }
        for (let y = minY; y < maxY; y++)
          for (let x = minX; x < maxX; x++) {
            add({ dimension, z, x, y });
          }
      }
      if (overviewSource) {
        sourceCandidates.push(source);
        if (!published.has(tilePath(source))) {
          if (tiles.length + temporary.length >= batch.limits.maxTiles)
            throw new RangeError(
              `Tile estimate including overview sources exceeds maxTiles (${batch.limits.maxTiles})`,
            );
          temporary.push(source);
        }
      }
    }
  }
  const overviewSources = new Map<string, TileCoordinates[]>();
  for (const source of sourceCandidates) {
    for (const zoom of overviewZooms) {
      const key = tilePath(mapTileAncestor(source, zoom));
      if (!published.has(key)) continue;
      const group = overviewSources.get(key) ?? [];
      group.push(source);
      overviewSources.set(key, group);
    }
  }
  for (const group of overviewSources.values()) group.sort(compareTiles);
  return {
    tiles: tiles.sort(compareTiles),
    temporary: temporary.sort(compareTiles),
    overviewSources,
  };
}

export function planTiles(
  world: Pick<MapWorld, "getTileCoverage">,
  batch: NormalizedBatch,
): readonly TileCoordinates[] {
  return createBatchPlan(world, batch).tiles;
}

function compareTiles(a: TileCoordinates, b: TileCoordinates): number {
  return a.dimension.localeCompare(b.dimension) || a.z - b.z || a.x - b.x || a.y - b.y;
}

export function tilePath(tile: TileCoordinates): string {
  return `${tile.dimension}/tiles/${tile.z}/${tile.x}/${tile.y}.png`;
}
