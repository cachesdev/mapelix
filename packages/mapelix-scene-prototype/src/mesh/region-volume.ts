import type { DecodedSubchunk } from "@mapelix/prototype/bedrock";

import { BASE_REGION_SPAN, WORLD_MAX_Y, WORLD_MIN_Y } from "../format.js";
import type { ChunkSource, DecodedChunk } from "../world/chunk-source.js";
import { BlockPalette, PALETTE_ID_MASK, Shape, WATERLOGGED } from "./block-palette.js";

/** Neighbor blocks loaded around a level 0 region, for culling, occlusion, and sky tracing. */
export const VOLUME_MARGIN = 16;
export const VOLUME_SIZE = BASE_REGION_SPAN + 2 * VOLUME_MARGIN;
export const VOLUME_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y;
export const VOLUME_LAYER = VOLUME_SIZE * VOLUME_SIZE;
/** Column height used when a column holds no block of the requested kind. */
export const NO_BLOCK = WORLD_MIN_Y - 1;

const CHUNKS_PER_SIDE = VOLUME_SIZE / 16;

/**
 * Every block of a level 0 region and its margin, as palette ids. Cells are
 * stored y-major: `(y - WORLD_MIN_Y) * VOLUME_LAYER + z * VOLUME_SIZE + x`.
 */
export interface RegionVolume {
  /** World block coordinates of volume cell (0, 0). */
  readonly originX: number;
  readonly originZ: number;
  readonly cells: Uint16Array;
  /** Highest opaque cube in each column. Air below it is covered from the sky. */
  readonly topSolid: Int16Array;
  /** Highest block of any visible kind in each column. */
  readonly topBlock: Int16Array;
  /** Biome id at the top of each column, or -1 where no chunk is stored. */
  readonly biomes: Int16Array;
}

export function cellIndex(x: number, y: number, z: number): number {
  return (y - WORLD_MIN_Y) * VOLUME_LAYER + z * VOLUME_SIZE + x;
}

/** Loads a region and its margin. Returns undefined when the region itself stores no chunk. */
export function buildRegionVolume(
  chunks: ChunkSource,
  palette: BlockPalette,
  regionX: number,
  regionZ: number,
): RegionVolume | undefined {
  const originX = regionX * BASE_REGION_SPAN - VOLUME_MARGIN;
  const originZ = regionZ * BASE_REGION_SPAN - VOLUME_MARGIN;
  const cells = new Uint16Array(VOLUME_LAYER * VOLUME_HEIGHT);
  const loaded: Array<DecodedChunk | undefined> = [];
  let regionHasChunks = false;

  for (let row = 0; row < CHUNKS_PER_SIDE; row += 1) {
    for (let column = 0; column < CHUNKS_PER_SIDE; column += 1) {
      const chunk = chunks.chunk(originX / 16 + column, originZ / 16 + row);
      if (chunk === undefined) continue;
      const insideRegion =
        row > 0 && row < CHUNKS_PER_SIDE - 1 && column > 0 && column < CHUNKS_PER_SIDE - 1;
      regionHasChunks ||= insideRegion;
      loaded[row * CHUNKS_PER_SIDE + column] = chunk;
      for (const section of chunk.sections) {
        writeSection(cells, palette, section, column * 16, row * 16);
      }
    }
  }
  if (!regionHasChunks) return undefined;

  const biomeAt = (x: number, y: number, z: number): number | undefined =>
    loaded[(z >> 4) * CHUNKS_PER_SIDE + (x >> 4)]?.biomes.at(x & 15, y, z & 15);
  return describeVolume({ originX, originZ, cells }, palette, biomeAt);
}

/**
 * Finds the column tops and surface biomes of a filled volume. Biomes are looked up
 * with volume-local coordinates; columns without a stored chunk get no biome.
 */
export function describeVolume(
  filled: Pick<RegionVolume, "originX" | "originZ" | "cells">,
  palette: BlockPalette,
  biomeAt: (x: number, y: number, z: number) => number | undefined,
): RegionVolume {
  const biomes = new Int16Array(VOLUME_LAYER).fill(-1);
  const topSolid = new Int16Array(VOLUME_LAYER).fill(NO_BLOCK);
  const topBlock = new Int16Array(VOLUME_LAYER).fill(NO_BLOCK);
  for (let z = 0; z < VOLUME_SIZE; z += 1) {
    for (let x = 0; x < VOLUME_SIZE; x += 1) {
      const column = z * VOLUME_SIZE + x;
      scanColumn(filled.cells, palette, column, topSolid, topBlock);
      const top = topBlock[column]!;
      biomes[column] = biomeAt(x, top === NO_BLOCK ? 64 : top, z) ?? -1;
    }
  }
  return { ...filled, topSolid, topBlock, biomes };
}

function writeSection(
  cells: Uint16Array,
  palette: BlockPalette,
  section: DecodedSubchunk,
  offsetX: number,
  offsetZ: number,
): void {
  if (section.y < WORLD_MIN_Y / 16 || section.y >= WORLD_MAX_Y / 16) return;
  const blocks = sectionCells(section, palette);
  const baseY = section.y * 16;
  for (let index = 0; index < 4096; index += 1) {
    const cell = blocks[index]!;
    if (cell === 0) continue;
    const x = offsetX + (index >> 8);
    const z = offsetZ + ((index >> 4) & 15);
    cells[cellIndex(x, baseY + (index & 15), z)] = cell;
  }
}

/**
 * The palette ids of a subchunk's blocks in Bedrock's order, `x * 256 + z * 16 + y`,
 * with `WATERLOGGED` set on blocks that hold water.
 */
export function sectionCells(section: DecodedSubchunk, palette: BlockPalette): Uint16Array {
  const storage = section.primary;
  const ids = Uint16Array.from(storage.palette, (name, index) =>
    palette.idFor(name, storage.states?.[index]),
  );
  // Bedrock keeps the water of waterlogged blocks in a second storage layer.
  const waterLayer = section.storages[1];
  const waterIds = waterLayer?.palette.map((name) => /(?:^|:)(?:flowing_)?water$/.test(name));
  const cells = new Uint16Array(4096);
  for (let index = 0; index < 4096; index += 1) {
    const logged =
      waterLayer !== undefined && waterIds?.[waterLayer.indexes[index]!] === true ? WATERLOGGED : 0;
    cells[index] = ids[storage.indexes[index]!]! | logged;
  }
  return cells;
}

function scanColumn(
  cells: Uint16Array,
  palette: BlockPalette,
  column: number,
  topSolid: Int16Array,
  topBlock: Int16Array,
): void {
  for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y -= 1) {
    const cell = cells[(y - WORLD_MIN_Y) * VOLUME_LAYER + column]!;
    const shape = palette.shape[cell & PALETTE_ID_MASK]!;
    if (topBlock[column] === NO_BLOCK && (shape !== Shape.Empty || cell & WATERLOGGED)) {
      topBlock[column] = y;
    }
    if (shape === Shape.Cube) {
      topSolid[column] = y;
      return;
    }
  }
}
