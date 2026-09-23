import { rgb } from "../blocks/block-appearance.js";
import {
  EMPTY_HEIGHT,
  FULL_BOX,
  Face,
  FULLY_LIT,
  QuadList,
  QuadMaterial,
  SOIL_COLOR,
  WORLD_MIN_Y,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
  regionCellSize,
  regionGridSize,
  regionSpan,
  type SceneRegion,
} from "../format.js";
import type { SurfaceSource } from "./surface-source.js";

const WATER_SURFACE = { size: 14, inset: 0, anchoredTop: false } as const;
const SIDES = [Face.PositiveX, Face.NegativeX, Face.PositiveZ, Face.NegativeZ] as const;
const FACE_STEPS: Readonly<Record<number, readonly [number, number]>> = {
  [Face.PositiveX]: [1, 0],
  [Face.NegativeX]: [-1, 0],
  [Face.PositiveZ]: [0, 1],
  [Face.NegativeZ]: [0, -1],
};
const SOIL = SOIL_COLOR;
const DEEP_ROCK = rgb(118, 116, 112);
/** Soil walls show dirt near the top and rock below, like a cut through a hill. */
const SOIL_DEPTH = 3;
/** Walls facing unexplored land reach this far below the cell, like the cut edge of a diorama. */
const EDGE_DEPTH = 16;
/** Trunks stand under crowns in cells up to this wide; wider cells would turn them into pillars. */
const MAX_TRUNK_CELL = 2;
/** Columns this close below a cell's highest column share in its color. */
const TOP_TOLERANCE = 1;

/**
 * Surfaces of a region's cells plus a one-cell ring of its neighbors at the
 * same level. The ring lets border walls stop at the neighbor's height instead of
 * dropping to the region floor. Index cells with `at(x, z)` for x and z in [-1, size].
 */
interface CellGrid {
  readonly size: number;
  readonly ground: Int16Array;
  readonly top: Uint32Array;
  readonly side: Uint32Array;
  /** 1 where most columns have soil sides under a strip of their top color. */
  readonly covered: Uint8Array;
  /** Tree crowns where most columns have leaves: a slab from its bottom to its top. */
  readonly canopyTop: Int16Array;
  readonly canopyBottom: Int16Array;
  readonly canopyColor: Uint32Array;
  readonly water: Int16Array;
  readonly waterColor: Uint32Array;
}

function at(grid: { readonly size: number }, x: number, z: number): number {
  return (z + 1) * (grid.size + 2) + x + 1;
}

/**
 * Meshes a coarse region as blocky columns: merged ground tops, walls where a
 * neighbor is lower, skirts along the border, tree crowns as floating slabs, and
 * a separate water surface.
 */
export function meshColumnRegion(
  surfaces: SurfaceSource,
  level: number,
  regionX: number,
  regionZ: number,
): SceneRegion | undefined {
  const cells = gatherCells(surfaces, level, regionX, regionZ);
  if (cells === undefined) return undefined;
  return new ColumnMesher(cells, regionCellSize(level)).mesh(level, regionX, regionZ);
}

/**
 * The highest ground in each cell and the average colors of the columns near it. Keeping
 * the top, as Distant Horizons does, lets thin spires, walls, and ridges survive coarse
 * cells instead of melting into their surroundings.
 */
class HighestGround {
  readonly height: Int16Array;
  readonly count: Uint16Array;
  /** Summed top and side colors, six channels per cell. */
  readonly colors: Float64Array;
  readonly covered: Uint16Array;

  constructor(cells: number) {
    this.height = new Int16Array(cells).fill(EMPTY_HEIGHT);
    this.count = new Uint16Array(cells);
    this.colors = new Float64Array(cells * 6);
    this.covered = new Uint16Array(cells);
  }

  add(cell: number, height: number, top: number, side: number, covered: number): void {
    if (height > this.height[cell]!) {
      // A new highest column restarts the colors, so a peak keeps its own color.
      this.height[cell] = height;
      this.count[cell] = 0;
      this.colors.fill(0, cell * 6, cell * 6 + 6);
      this.covered[cell] = 0;
    }
    if (height < this.height[cell]! - TOP_TOLERANCE) return;
    this.count[cell] = this.count[cell]! + 1;
    addColor(this.colors, cell * 6, top);
    addColor(this.colors, cell * 6 + 3, side);
    this.covered[cell] = this.covered[cell]! + covered;
  }

  write(grid: CellGrid, cell: number): void {
    const samples = this.count[cell]!;
    grid.ground[cell] = this.height[cell]!;
    grid.top[cell] = averageColor(this.colors, cell * 6, samples);
    grid.side[cell] = averageColor(this.colors, cell * 6 + 3, samples);
    grid.covered[cell] = this.covered[cell]! * 2 > samples ? 1 : 0;
  }
}

function gatherCells(
  surfaces: SurfaceSource,
  level: number,
  regionX: number,
  regionZ: number,
): CellGrid | undefined {
  const span = regionSpan(level);
  const cellSize = regionCellSize(level);
  const size = regionGridSize(level);
  const cells = (size + 2) ** 2;
  const count = new Uint16Array(cells);
  const land = new HighestGround(cells);
  // Beds under water, so a mostly wet cell keeps its seabed and the shore stays in place.
  const bed = new HighestGround(cells);
  const canopyCount = new Uint16Array(cells);
  const canopyTop = new Int16Array(cells).fill(EMPTY_HEIGHT);
  const canopyBottom = new Float64Array(cells);
  const canopyColors = new Float64Array(cells * 3);
  const waterCount = new Uint16Array(cells);
  const waterHeight = new Float64Array(cells);
  const waterColors = new Float64Array(cells * 3);
  let stored = false;

  const chunksPerSide = span / 16;
  // Chunk keys sort by x first, so walking z inside x reuses cached table blocks.
  for (let chunkColumn = -1; chunkColumn <= chunksPerSide; chunkColumn += 1) {
    for (let chunkRow = -1; chunkRow <= chunksPerSide; chunkRow += 1) {
      const chunkX = (regionX * span) / 16 + chunkColumn;
      const chunkZ = (regionZ * span) / 16 + chunkRow;
      const surface = surfaces.surface(chunkX, chunkZ);
      if (surface === undefined) continue;
      const inside =
        chunkRow >= 0 &&
        chunkColumn >= 0 &&
        chunkRow < chunksPerSide &&
        chunkColumn < chunksPerSide;
      stored ||= inside;
      for (let column = 0; column < 256; column += 1) {
        const height = surface.ground[column]!;
        if (height === EMPTY_HEIGHT) continue;
        const cellX = Math.floor((chunkColumn * 16 + (column & 15)) / cellSize);
        const cellZ = Math.floor((chunkRow * 16 + (column >> 4)) / cellSize);
        if (cellX < -1 || cellZ < -1 || cellX > size || cellZ > size) continue;
        const cell = at({ size }, cellX, cellZ);
        const top = surface.top[column]!;
        const side = surface.side[column]!;
        const covered = surface.covered[column]!;
        count[cell] = count[cell]! + 1;
        const trunk = surface.trunk[column]!;
        if (trunk !== EMPTY_HEIGHT && cellSize <= MAX_TRUNK_CELL) {
          const bark = surface.trunkColor[column]!;
          land.add(cell, trunk, bark, bark, 0);
        } else {
          land.add(cell, height, top, side, covered);
        }
        if (surface.canopy[column] !== EMPTY_HEIGHT) {
          canopyCount[cell] = canopyCount[cell]! + 1;
          canopyTop[cell] = Math.max(canopyTop[cell]!, surface.canopy[column]!);
          canopyBottom[cell] = canopyBottom[cell]! + surface.canopyBottom[column]!;
          addColor(canopyColors, cell * 3, surface.canopyColor[column]!);
        }
        if (surface.water[column] !== EMPTY_HEIGHT) {
          waterCount[cell] = waterCount[cell]! + 1;
          waterHeight[cell] = waterHeight[cell]! + surface.water[column]!;
          addColor(waterColors, cell * 3, surface.waterColor[column]!);
          bed.add(cell, height, top, side, covered);
        }
      }
    }
  }
  if (!stored) return undefined;

  const grid: CellGrid = {
    size,
    ground: new Int16Array(cells).fill(EMPTY_HEIGHT),
    top: new Uint32Array(cells),
    side: new Uint32Array(cells),
    covered: new Uint8Array(cells),
    canopyTop: new Int16Array(cells).fill(EMPTY_HEIGHT),
    canopyBottom: new Int16Array(cells),
    canopyColor: new Uint32Array(cells),
    water: new Int16Array(cells).fill(EMPTY_HEIGHT),
    waterColor: new Uint32Array(cells),
  };
  for (let cell = 0; cell < cells; cell += 1) {
    const samples = count[cell]!;
    if (samples === 0) continue;
    const wet = waterCount[cell]!;
    if (wet * 2 > samples) {
      bed.write(grid, cell);
      grid.water[cell] = Math.round(waterHeight[cell]! / wet);
      grid.waterColor[cell] = averageColor(waterColors, cell * 3, wet);
    } else {
      land.write(grid, cell);
    }
    // A quarter of the cell in leaves is enough for a crown, so tree lines stay visible.
    const leaves = canopyCount[cell]!;
    if (leaves * 4 >= samples) {
      const top = canopyTop[cell]!;
      grid.canopyTop[cell] = top;
      grid.canopyBottom[cell] = Math.min(Math.round(canopyBottom[cell]! / leaves), top - 1);
      grid.canopyColor[cell] = averageColor(canopyColors, cell * 3, leaves);
    }
  }
  return grid;
}

/** A run of equal wall faces along one row of cells. */
interface Wall {
  readonly start: number;
  readonly bottom: number;
  readonly top: number;
  readonly color: number;
  /** Leaf walls are one face. Ground walls show soil and rock below their top. */
  readonly leaves: boolean;
  readonly covered: boolean;
}

type WallFace = Omit<Wall, "start">;

/** The wall a cell shows toward its neighbor at (`nx`, `nz`), if any. */
type WallAt = (x: number, z: number, nx: number, nz: number) => WallFace | undefined;

class ColumnMesher {
  private readonly cells: CellGrid;
  private readonly opaque = new QuadList();
  private readonly translucent = new QuadList();
  /** How far border walls reach below the neighbor, covering seams between detail levels. */
  private readonly overlap: number;
  private minY = Number.POSITIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;

  constructor(cells: CellGrid, cellSize: number) {
    this.cells = cells;
    this.overlap = 2 + cellSize / 2;
  }

  mesh(level: number, regionX: number, regionZ: number): SceneRegion {
    const { ground, canopyTop } = this.cells;
    this.meshTops(ground, (cell) => this.cells.top[cell]!, QuadMaterial.Solid);
    this.meshTops(canopyTop, (cell) => this.cells.canopyColor[cell]!, QuadMaterial.Foliage);
    this.meshCanopyUndersides();
    for (const face of SIDES) {
      this.meshWalls(face, (x, z, nx, nz) => this.groundWall(x, z, nx, nz));
      this.meshWalls(face, (x, z, nx, nz) => this.canopyWall(x, z, nx, nz, "upper"));
      this.meshWalls(face, (x, z, nx, nz) => this.canopyWall(x, z, nx, nz, "lower"));
    }
    this.meshWater();

    const { size, water } = this.cells;
    const heights = new Int16Array(size * size);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        heights[z * size + x] = Math.max(ground[cell]!, canopyTop[cell]!, water[cell]!);
      }
    }
    return {
      level,
      x: regionX,
      z: regionZ,
      heights,
      minY: Number.isFinite(this.minY) ? this.minY : 0,
      maxY: Number.isFinite(this.maxY) ? this.maxY : 0,
      opaque: this.opaque.finish(),
      plants: new Uint32Array(0),
      translucent: this.translucent.finish(),
    };
  }

  /** Greedy-merges the tops of one height layer with equal height, color, and occlusion. */
  private meshTops(
    heights: Int16Array,
    colorAt: (cell: number) => number,
    material: QuadMaterial,
  ): void {
    const { size } = this.cells;
    const keys = new Float64Array(size * size).fill(-1);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        if (heights[cell] === EMPTY_HEIGHT) continue;
        const word2 = packQuadWord2(colorAt(cell), this.topOcclusion(heights, x, z));
        // Height and packed color fit exactly in a double: 9 + 32 bits.
        keys[z * size + x] = (heights[cell]! - WORLD_MIN_Y) * 2 ** 32 + word2;
      }
    }
    mergeGrid(keys, size, (x, z, width, depth, key) => {
      const height = heights[at(this.cells, x, z)]!;
      this.push(
        this.opaque,
        packQuadWord0(x, height - 1, z, Face.PositiveY, material),
        packQuadWord1(width, depth, FULL_BOX, 0),
        key % 2 ** 32,
        height - 1,
        height,
      );
    });
  }

  private meshCanopyUndersides(): void {
    const { size, canopyTop, canopyBottom, canopyColor } = this.cells;
    const keys = new Float64Array(size * size).fill(-1);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        if (canopyTop[cell] === EMPTY_HEIGHT) continue;
        keys[z * size + x] = (canopyBottom[cell]! - WORLD_MIN_Y) * 2 ** 24 + canopyColor[cell]!;
      }
    }
    mergeGrid(keys, size, (x, z, width, depth) => {
      const cell = at(this.cells, x, z);
      const bottom = canopyBottom[cell]!;
      this.push(
        this.opaque,
        packQuadWord0(x, bottom, z, Face.NegativeY, QuadMaterial.Foliage),
        packQuadWord1(width, depth, FULL_BOX, 0),
        packQuadWord2(canopyColor[cell]!, FULLY_LIT),
        bottom,
        bottom + 1,
      );
    });
  }

  /** Merges equal walls along each row of cells that face `face`. */
  private meshWalls(face: Face, wallAt: WallAt): void {
    const { size } = this.cells;
    const [dx, dz] = FACE_STEPS[face]!;
    const alongX = dz !== 0;
    for (let row = 0; row < size; row += 1) {
      let run: Wall | undefined;
      const flush = (end: number): void => {
        if (run !== undefined) this.pushWall(face, alongX, row, run.start, end - run.start, run);
        run = undefined;
      };
      for (let step = 0; step < size; step += 1) {
        const x = alongX ? step : row;
        const z = alongX ? row : step;
        const wall = wallAt(x, z, x + dx, z + dz);
        if (wall === undefined) {
          flush(step);
        } else if (run === undefined || !sameWall(run, wall)) {
          flush(step);
          run = { start: step, ...wall };
        }
      }
      flush(size);
    }
  }

  /**
   * Ground walls face lower neighbors. Along the border they also reach `overlap` blocks
   * below the neighbor, so a coarser or finer region beside this one never leaves a gap.
   */
  private groundWall(x: number, z: number, nx: number, nz: number): WallFace | undefined {
    const cell = at(this.cells, x, z);
    const height = this.cells.ground[cell]!;
    if (height === EMPTY_HEIGHT) return undefined;
    const bottom = this.wallBottom(nx, nz, height);
    if (bottom >= height) return undefined;
    const covered = this.cells.covered[cell] === 1;
    return {
      bottom,
      top: height,
      // Covered walls carry the top color for their strip; the shader draws soil below it.
      color: covered ? this.cells.top[cell]! : this.cells.side[cell]!,
      leaves: false,
      covered,
    };
  }

  private wallBottom(x: number, z: number, height: number): number {
    const neighbor = this.cells.ground[at(this.cells, x, z)]!;
    if (neighbor === EMPTY_HEIGHT) return Math.max(WORLD_MIN_Y, height - EDGE_DEPTH);
    const border = x < 0 || z < 0 || x >= this.cells.size || z >= this.cells.size;
    return border ? Math.min(neighbor, height) - this.overlap : neighbor;
  }

  /**
   * The side of a crown that a neighboring crown does not cover: the part above
   * the neighbor's top, or the part below its bottom. Ground beside it hides the rest.
   */
  private canopyWall(
    x: number,
    z: number,
    nx: number,
    nz: number,
    part: "upper" | "lower",
  ): WallFace | undefined {
    const { canopyTop, canopyBottom, canopyColor, ground } = this.cells;
    const cell = at(this.cells, x, z);
    const neighbor = at(this.cells, nx, nz);
    if (canopyTop[cell] === EMPTY_HEIGHT) return undefined;
    const open = canopyTop[neighbor] === EMPTY_HEIGHT;
    // Without a neighboring crown the upper part is the whole side.
    if (open && part === "lower") return undefined;

    let bottom = canopyBottom[cell]!;
    let top = canopyTop[cell]!;
    if (!open && part === "upper") bottom = Math.max(bottom, canopyTop[neighbor]!);
    if (!open && part === "lower") top = Math.min(top, canopyBottom[neighbor]!);
    bottom = Math.max(bottom, ground[neighbor]!);
    if (bottom >= top) return undefined;
    return { bottom, top, color: canopyColor[cell]!, leaves: true, covered: false };
  }

  private pushWall(
    face: Face,
    alongX: boolean,
    row: number,
    start: number,
    length: number,
    wall: Wall,
  ): void {
    const x = alongX ? start : row;
    const z = alongX ? row : start;
    const material = wall.leaves ? QuadMaterial.Foliage : QuadMaterial.Solid;
    const side = (bottom: number, top: number, color: number, covered = false): void =>
      this.push(
        this.opaque,
        packQuadWord0(x, bottom, z, face, material, covered),
        packQuadWord1(length, top - bottom, FULL_BOX, 0),
        packQuadWord2(color, FULLY_LIT),
        bottom,
        top,
      );

    if (wall.leaves) {
      side(wall.bottom, wall.top, wall.color);
      return;
    }
    const soil = (wall.covered || wall.color === SOIL) && wall.top - wall.bottom > SOIL_DEPTH + 1;
    const rock = soil ? wall.top - SOIL_DEPTH : wall.bottom;
    if (rock > wall.bottom) side(wall.bottom, rock, DEEP_ROCK);
    side(rock, wall.top, wall.color, wall.covered);
  }

  private meshWater(): void {
    const { size, water, waterColor } = this.cells;
    const keys = new Float64Array(size * size).fill(-1);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        if (water[cell] !== EMPTY_HEIGHT) {
          keys[z * size + x] = (water[cell]! - WORLD_MIN_Y) * 2 ** 24 + waterColor[cell]!;
        }
      }
    }
    mergeGrid(keys, size, (x, z, width, depth) => {
      const cell = at(this.cells, x, z);
      const height = water[cell]!;
      this.push(
        this.translucent,
        packQuadWord0(x, height - 1, z, Face.PositiveY, QuadMaterial.Water),
        packQuadWord1(width, depth, WATER_SURFACE, 0),
        packQuadWord2(waterColor[cell]!, FULLY_LIT),
        height - 1,
        height,
      );
    });
  }

  /** Darkens top corners next to taller neighbors, the column version of voxel occlusion. */
  private topOcclusion(heights: Int16Array, x: number, z: number): number {
    const height = heights[at(this.cells, x, z)]!;
    const taller = (cx: number, cz: number): boolean => heights[at(this.cells, cx, cz)]! > height;
    let packed = 0;
    const corners = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const;
    for (let corner = 0; corner < 4; corner += 1) {
      const [su, sv] = corners[corner]!;
      const side1 = taller(x + su, z);
      const side2 = taller(x, z + sv);
      const diagonal = taller(x + su, z + sv);
      const level = side1 && side2 ? 0 : 3 - Number(side1) - Number(side2) - Number(diagonal);
      packed |= level << (corner * 2);
    }
    return packed;
  }

  private push(
    list: QuadList,
    word0: number,
    word1: number,
    word2: number,
    bottom: number,
    top: number,
  ): void {
    list.push(word0, word1, word2);
    this.minY = Math.min(this.minY, bottom);
    this.maxY = Math.max(this.maxY, top);
  }
}

function sameWall(left: Wall, right: WallFace): boolean {
  return (
    left.bottom === right.bottom &&
    left.top === right.top &&
    left.color === right.color &&
    left.leaves === right.leaves &&
    left.covered === right.covered
  );
}

/** Greedy rectangle merge over a grid of keys, where -1 means no face. */
function mergeGrid(
  keys: Float64Array,
  size: number,
  emit: (x: number, z: number, width: number, depth: number, key: number) => void,
): void {
  for (let z = 0; z < size; z += 1) {
    for (let x = 0; x < size; x += 1) {
      const key = keys[z * size + x]!;
      if (key < 0) continue;
      let width = 1;
      while (x + width < size && keys[z * size + x + width] === key) width += 1;
      let depth = 1;
      while (z + depth < size && rowEquals(keys, (z + depth) * size + x, width, key)) depth += 1;
      for (let row = 0; row < depth; row += 1) {
        keys.fill(-1, (z + row) * size + x, (z + row) * size + x + width);
      }
      emit(x, z, width, depth, key);
    }
  }
}

function rowEquals(keys: Float64Array, start: number, width: number, key: number): boolean {
  for (let offset = 0; offset < width; offset += 1) if (keys[start + offset] !== key) return false;
  return true;
}

function addColor(sums: Float64Array, offset: number, color: number): void {
  sums[offset] = sums[offset]! + ((color >> 16) & 0xff);
  sums[offset + 1] = sums[offset + 1]! + ((color >> 8) & 0xff);
  sums[offset + 2] = sums[offset + 2]! + (color & 0xff);
}

function averageColor(sums: Float64Array, offset: number, samples: number): number {
  const channel = (index: number): number => Math.round(sums[offset + index]! / samples);
  return (channel(0) << 16) | (channel(1) << 8) | channel(2);
}
