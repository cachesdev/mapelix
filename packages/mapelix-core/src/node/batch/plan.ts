import type { MapWorld, TileCoordinates } from "../../types.js";
import type { NormalizedBatch } from "./types.js";

/** Expands only occupied z=0 cells, never the bounding rectangle of a sparse world. */
export function planTiles(
  world: Pick<MapWorld, "getTileCoverage">,
  batch: NormalizedBatch,
): TileCoordinates[] {
  const tiles: TileCoordinates[] = [];
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
      for (const z of batch.zooms) {
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
        if (count > batch.limits.maxTiles - tiles.length) {
          throw new RangeError(`Tile estimate exceeds maxTiles (${batch.limits.maxTiles})`);
        }
        for (let y = minY; y < maxY; y++)
          for (let x = minX; x < maxX; x++) {
            tiles.push({ dimension, z, x, y });
          }
      }
    }
  }
  return tiles.sort(
    (a, b) => a.dimension.localeCompare(b.dimension) || a.z - b.z || a.x - b.x || a.y - b.y,
  );
}

export function tilePath(tile: TileCoordinates): string {
  return `${tile.dimension}/tiles/${tile.z}/${tile.x}/${tile.y}.png`;
}
