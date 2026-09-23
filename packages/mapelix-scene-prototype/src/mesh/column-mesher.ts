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
/** Walls facing unexplored land reach this far below the lowest cell. */
const EDGE_DEPTH = 6;

/**
 * Averaged surfaces of a region's cells plus a one-cell ring of its neighbors at the
 * same level. The ring lets border walls stop at the neighbor's height instead of
 * dropping to the region floor. Index cells with `at(x, z)` for x and z in [-1, size].
 */
interface CellGrid {
  readonly size: number;
  readonly ground: Int16Array;
  readonly top: Uint32Array;
  readonly side: Uint32Array;
  readonly foliage: Uint8Array;
  /** 1 where most columns have soil sides under a strip of their top color. */
  readonly covered: Uint8Array;
  readonly water: Int16Array;
  readonly waterColor: Uint32Array;
}

function at(grid: { readonly size: number }, x: number, z: number): number {
  return (z + 1) * (grid.size + 2) + x + 1;
}

/**
 * Meshes a coarse region as blocky columns: merged tops, walls where a neighbor
 * is lower, skirts along the border, and a separate water surface.
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
  const ground = new Float64Array(cells);
  const colors = new Float64Array(cells * 6);
  const foliage = new Uint16Array(cells);
  const covered = new Uint16Array(cells);
  const waterCount = new Uint16Array(cells);
  const waterHeight = new Float64Array(cells);
  const waterColors = new Float64Array(cells * 3);
  let stored = false;

  const chunksPerSide = span / 16;
  for (let chunkRow = -1; chunkRow <= chunksPerSide; chunkRow += 1) {
    for (let chunkColumn = -1; chunkColumn <= chunksPerSide; chunkColumn += 1) {
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
        count[cell] = count[cell]! + 1;
        ground[cell] = ground[cell]! + height;
        addColor(colors, cell * 6, surface.top[column]!);
        addColor(colors, cell * 6 + 3, surface.side[column]!);
        foliage[cell] = foliage[cell]! + surface.foliage[column]!;
        covered[cell] = covered[cell]! + surface.covered[column]!;
        if (surface.water[column] !== EMPTY_HEIGHT) {
          waterCount[cell] = waterCount[cell]! + 1;
          waterHeight[cell] = waterHeight[cell]! + surface.water[column]!;
          addColor(waterColors, cell * 3, surface.waterColor[column]!);
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
    foliage: new Uint8Array(cells),
    covered: new Uint8Array(cells),
    water: new Int16Array(cells).fill(EMPTY_HEIGHT),
    waterColor: new Uint32Array(cells),
  };
  for (let cell = 0; cell < cells; cell += 1) {
    const samples = count[cell]!;
    if (samples === 0) continue;
    grid.ground[cell] = Math.round(ground[cell]! / samples);
    grid.top[cell] = averageColor(colors, cell * 6, samples);
    grid.side[cell] = averageColor(colors, cell * 6 + 3, samples);
    grid.foliage[cell] = foliage[cell]! * 2 > samples ? 1 : 0;
    grid.covered[cell] = covered[cell]! * 2 > samples ? 1 : 0;
    const wet = waterCount[cell]!;
    if (wet * 2 > samples) {
      grid.water[cell] = Math.round(waterHeight[cell]! / wet);
      grid.waterColor[cell] = averageColor(waterColors, cell * 3, wet);
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
  readonly covered: boolean;
}

class ColumnMesher {
  private readonly cells: CellGrid;
  private readonly opaque = new QuadList();
  private readonly translucent = new QuadList();
  /** Bottom of walls that face unexplored land. */
  private readonly edgeBottom: number;
  /** How far border walls reach below the neighbor, covering seams between detail levels. */
  private readonly overlap: number;
  private minY = Number.POSITIVE_INFINITY;
  private maxY = Number.NEGATIVE_INFINITY;

  constructor(cells: CellGrid, cellSize: number) {
    this.cells = cells;
    let lowest = Number.POSITIVE_INFINITY;
    for (const height of cells.ground) {
      if (height !== EMPTY_HEIGHT) lowest = Math.min(lowest, height);
    }
    this.edgeBottom = Math.max(WORLD_MIN_Y, lowest - EDGE_DEPTH);
    this.overlap = 2 + cellSize / 2;
  }

  mesh(level: number, regionX: number, regionZ: number): SceneRegion {
    this.meshTops();
    for (const face of [Face.PositiveX, Face.NegativeX, Face.PositiveZ, Face.NegativeZ]) {
      this.meshWalls(face);
    }
    this.meshWater();
    const { size, ground, water } = this.cells;
    const heights = new Int16Array(size * size);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        heights[z * size + x] = Math.max(ground[cell]!, water[cell]!);
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

  /** Greedy-merges column tops with equal height, color, material, and occlusion. */
  private meshTops(): void {
    const { size, ground, top, foliage } = this.cells;
    const keys = new Float64Array(size * size).fill(-1);
    for (let z = 0; z < size; z += 1) {
      for (let x = 0; x < size; x += 1) {
        const cell = at(this.cells, x, z);
        if (ground[cell] === EMPTY_HEIGHT) continue;
        const word2 = packQuadWord2(top[cell]!, this.topOcclusion(x, z));
        // Height, packed color, and material fit exactly in a double: 9 + 32 + 1 bits.
        keys[z * size + x] = (ground[cell]! - WORLD_MIN_Y) * 2 ** 33 + word2 * 2 + foliage[cell]!;
      }
    }
    mergeGrid(keys, size, (x, z, width, depth, key) => {
      const cell = at(this.cells, x, z);
      const material = foliage[cell] === 1 ? QuadMaterial.Foliage : QuadMaterial.Solid;
      const height = ground[cell]!;
      this.push(
        this.opaque,
        packQuadWord0(x, height - 1, z, Face.PositiveY, material),
        packQuadWord1(width, depth, FULL_BOX, 0),
        Math.floor(key / 2) % 2 ** 32,
        height - 1,
        height,
      );
    });
  }

  /**
   * Walls face lower neighbors. Along the border they also reach `overlap` blocks below
   * the neighbor, so a coarser or finer region beside this one never leaves a gap.
   */
  private meshWalls(face: Face): void {
    const { size, ground, side, top, covered } = this.cells;
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
        const height = ground[at(this.cells, x, z)]!;
        const bottom = this.wallBottom(x + dx, z + dz, height);
        if (height === EMPTY_HEIGHT || bottom >= height) {
          flush(step);
          continue;
        }
        const cell = at(this.cells, x, z);
        const cover = covered[cell] === 1;
        // Covered walls carry the top color for their strip; the shader draws soil below it.
        const color = cover ? top[cell]! : side[cell]!;
        const same =
          run !== undefined &&
          run.bottom === bottom &&
          run.top === height &&
          run.color === color &&
          run.covered === cover;
        if (!same) {
          flush(step);
          run = { start: step, bottom, top: height, color, covered: cover };
        }
      }
      flush(size);
    }
  }

  private wallBottom(x: number, z: number, height: number): number {
    const neighbor = this.cells.ground[at(this.cells, x, z)]!;
    if (neighbor === EMPTY_HEIGHT) return this.edgeBottom;
    const border = x < 0 || z < 0 || x >= this.cells.size || z >= this.cells.size;
    return border ? Math.min(neighbor, height) - this.overlap : neighbor;
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
    const soil = (wall.covered || wall.color === SOIL) && wall.top - wall.bottom > SOIL_DEPTH + 1;
    const split = soil ? wall.top - SOIL_DEPTH : wall.bottom;
    if (split > wall.bottom) {
      this.push(
        this.opaque,
        packQuadWord0(x, wall.bottom, z, face, QuadMaterial.Solid),
        packQuadWord1(length, split - wall.bottom, FULL_BOX, 0),
        packQuadWord2(DEEP_ROCK, FULLY_LIT),
        wall.bottom,
        split,
      );
    }
    this.push(
      this.opaque,
      packQuadWord0(x, split, z, face, QuadMaterial.Solid, wall.covered),
      packQuadWord1(length, wall.top - split, FULL_BOX, 0),
      packQuadWord2(wall.color, FULLY_LIT),
      split,
      wall.top,
    );
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
  private topOcclusion(x: number, z: number): number {
    const { ground } = this.cells;
    const height = ground[at(this.cells, x, z)]!;
    const taller = (cx: number, cz: number): boolean => ground[at(this.cells, cx, cz)]! > height;
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
