import {
  EMPTY_HEIGHT,
  WORLD_MIN_Y,
  type DecodedSceneRegion,
} from "@mapelix/scene-prototype/format";
import type { Vector3 } from "three/webgpu";

/** Where a ray meets a face. */
export interface SurfaceHit {
  /** Blocks along the ray. */
  readonly distance: number;
  /** The axis the face looks along: 0 for x, 1 for y, 2 for z. */
  readonly axis: number;
  /** The side the face looks toward along its axis, 1 or -1. */
  readonly sign: number;
}

/** Cells along each side of a collider tile. */
const TILE = 16;
/** The two tangent axes of a face on each axis, as the vertex shader lays them out. */
const TANGENTS = [
  [2, 1],
  [0, 2],
  [0, 1],
] as const;

/** A quad as an axis-aligned rectangle in region cells. `low` and `high` match on `axis`. */
interface FaceBox {
  axis: number;
  positive: boolean;
  readonly low: Float64Array;
  readonly high: Float64Array;
}

interface Tile {
  /** A box around every quad in the tile, in region cells. */
  readonly low: Float64Array;
  readonly high: Float64Array;
  /** Quads that reach into the tile: index times two, plus one for translucent quads. */
  refs: Uint32Array;
}

// Scratch space, so rays cast every frame allocate nothing per quad. The ray is kept in
// the space of whatever it is tested against: region cells for quads, blocks for regions.
const face: FaceBox = {
  axis: 0,
  positive: true,
  low: new Float64Array(3),
  high: new Float64Array(3),
};
const rayOrigin = new Float64Array(3);
const rayDirection = new Float64Array(3);
const regionLow = new Float64Array(3);
const regionHigh = new Float64Array(3);

/**
 * Casts rays against one region's opaque and translucent quads. Plants are left out.
 * The region is split into square tiles, so a ray tests only the quads of the tiles
 * it passes through.
 */
export class QuadCollider {
  private readonly region: DecodedSceneRegion;
  private readonly lists: readonly [Uint32Array, Uint32Array];
  /** Row-major tiles, `side` by `side`. */
  private readonly tiles: Tile[] = [];
  private readonly side: number;
  /** Quads are sorted into tiles the first time a ray reaches one. */
  private sorted = false;

  constructor(region: DecodedSceneRegion) {
    this.region = region;
    this.lists = [region.opaque, region.translucent];
    this.side = Math.ceil(region.gridSize / TILE);

    // No quad reaches above the height map one cell around it, so the tile boxes come
    // from heights, and a ray can pass over the region without sorting its quads.
    const bottom = region.minY / region.cellSize - 1;
    for (let z = 0; z < region.gridSize; z += TILE) {
      for (let x = 0; x < region.gridSize; x += TILE) {
        const top = Math.max(bottom, highestAround(region, x, z) / region.cellSize);
        this.tiles.push({
          low: Float64Array.of(x, bottom, z),
          high: Float64Array.of(x + TILE, top, z + TILE),
          refs: new Uint32Array(0),
        });
      }
    }
  }

  /**
   * The nearest front face along a ray before `far`, treating the ray as a cube
   * `radius` blocks from its center to each side. `direction` has unit length.
   */
  raycast(
    origin: Vector3,
    direction: Vector3,
    far: number,
    radius: number,
  ): SurfaceHit | undefined {
    // Work in region cells. Scaling the direction too keeps distances in blocks.
    const { originX, originZ, cellSize } = this.region;
    rayOrigin.set([
      (origin.x - originX) / cellSize,
      origin.y / cellSize,
      (origin.z - originZ) / cellSize,
    ]);
    rayDirection.set([direction.x / cellSize, direction.y / cellSize, direction.z / cellSize]);
    const room = radius / cellSize;

    const crossed: { readonly tile: Tile; readonly entry: number }[] = [];
    for (const tile of this.tiles) {
      const entry = grownBoxEntry(tile.low, tile.high, room, far);
      if (entry < far) crossed.push({ tile, entry });
    }
    if (crossed.length > 0 && !this.sorted) this.sortQuads();
    crossed.sort((left, right) => left.entry - right.entry);

    let best = far;
    let hit: SurfaceHit | undefined;
    for (const { tile, entry } of crossed) {
      if (entry >= best) break;
      for (const ref of tile.refs) {
        readFace(this.lists[ref & 1]!, ref >>> 1, face);
        const distance = faceDistance(room, best);
        if (distance >= best) continue;
        best = distance;
        hit = { distance, axis: face.axis, sign: face.positive ? 1 : -1 };
      }
    }
    return hit;
  }

  /** Lists each quad in every tile it reaches. */
  private sortQuads(): void {
    const refs: number[][] = this.tiles.map(() => []);
    for (const [list, words] of this.lists.entries()) {
      for (let index = 0; index < words.length / 3; index += 1) {
        if (!readFace(words, index, face)) continue;
        const [x0, x1] = tileRange(face.low[0]!, face.high[0]!, this.side);
        const [z0, z1] = tileRange(face.low[2]!, face.high[2]!, this.side);
        for (let tz = z0; tz <= z1; tz += 1) {
          for (let tx = x0; tx <= x1; tx += 1) refs[tz * this.side + tx]!.push(index * 2 + list);
        }
      }
    }
    for (const [tile, list] of refs.entries()) this.tiles[tile]!.refs = Uint32Array.from(list);
    this.sorted = true;
  }
}

/** Distance along a ray to where it enters a region's box, or Infinity when it misses before `far`. */
export function regionEntry(
  region: DecodedSceneRegion,
  origin: Vector3,
  direction: Vector3,
  far: number,
  radius: number,
): number {
  const { originX, originZ, cellSize, gridSize } = region;
  rayOrigin.set([origin.x, origin.y, origin.z]);
  rayDirection.set([direction.x, direction.y, direction.z]);
  regionLow.set([originX, region.minY - cellSize, originZ]);
  regionHigh.set([
    originX + gridSize * cellSize,
    region.maxY + cellSize,
    originZ + gridSize * cellSize,
  ]);
  return grownBoxEntry(regionLow, regionHigh, radius, far);
}

/** Reads a packed quad into `out`, the same way the vertex shader places it. Plants return false. */
function readFace(words: Uint32Array, index: number, out: FaceBox): boolean {
  const word0 = words[index * 3]!;
  const word1 = words[index * 3 + 1]!;
  const code = (word0 >>> 23) & 0x7;
  if (code >= 6) return false;

  const size = (((word1 >>> 16) & 0xf) + 1) / 16;
  const inset = ((word1 >>> 20) & 0x7) / 16;
  const bottom = ((word1 >>> 23) & 1) === 1 ? 1 - size : 0;
  const x = word0 & 0x7f;
  const y = ((word0 >>> 14) & 0x1ff) + WORLD_MIN_Y;
  const z = (word0 >>> 7) & 0x7f;
  const { low, high } = out;
  low[0] = x + inset;
  low[1] = y + bottom;
  low[2] = z + inset;
  high[0] = x + 1 - inset;
  high[1] = y + bottom + size;
  high[2] = z + 1 - inset;

  // The face lies on one side of its box, and stretches over `width` by `height` cells.
  const axis = code >> 1;
  const tangents = TANGENTS[axis]!;
  out.axis = axis;
  out.positive = (code & 1) === 0;
  if (out.positive) low[axis] = high[axis]!;
  else high[axis] = low[axis]!;
  high[tangents[0]] += word1 & 0x7f;
  high[tangents[1]] += (word1 >>> 7) & 0x1ff;
  return true;
}

/**
 * Distance along the ray to the front of `face` grown by `room`, or `best`
 * when the ray misses it, leaves it behind, or reaches it from behind.
 */
function faceDistance(room: number, best: number): number {
  const { axis, positive, low, high } = face;
  const toward = rayDirection[axis]!;
  if (positive ? toward >= 0 : toward <= 0) return best;
  const plane = low[axis]! + (positive ? room : -room);
  const distance = (plane - rayOrigin[axis]!) / toward;
  if (distance < 0 || distance >= best) return best;
  for (const other of TANGENTS[axis]!) {
    const at = rayOrigin[other]! + distance * rayDirection[other]!;
    if (at < low[other]! - room || at > high[other]! + room) return best;
  }
  return distance;
}

/** Slab test of the ray against a box grown by `room`. Returns Infinity on a miss. */
function grownBoxEntry(low: Float64Array, high: Float64Array, room: number, far: number): number {
  let entry = 0;
  let exit = far;
  for (let axis = 0; axis < 3; axis += 1) {
    const start = rayOrigin[axis]!;
    const step = rayDirection[axis]!;
    const from = low[axis]! - room;
    const to = high[axis]! + room;
    if (step === 0) {
      if (start < from || start > to) return Infinity;
      continue;
    }
    const first = (from - start) / step;
    const second = (to - start) / step;
    entry = Math.max(entry, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (entry > exit) return Infinity;
  }
  return entry;
}

/** The highest block top over a tile and one cell around it, in blocks. */
function highestAround(region: DecodedSceneRegion, x: number, z: number): number {
  const { gridSize, heights } = region;
  let highest = -Infinity;
  for (let cellZ = Math.max(0, z - 1); cellZ <= Math.min(gridSize - 1, z + TILE); cellZ += 1) {
    for (let cellX = Math.max(0, x - 1); cellX <= Math.min(gridSize - 1, x + TILE); cellX += 1) {
      const height = heights[cellZ * gridSize + cellX]!;
      if (height !== EMPTY_HEIGHT) highest = Math.max(highest, height);
    }
  }
  return highest;
}

/** The first and last tiles a cell range touches along one axis. */
function tileRange(low: number, high: number, side: number): [number, number] {
  const first = Math.min(side - 1, Math.max(0, Math.floor(low / TILE)));
  const last = Math.min(side - 1, Math.max(0, Math.floor(high / TILE)));
  return [first, last];
}
