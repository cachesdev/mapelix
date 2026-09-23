import { rgb } from "../blocks/block-appearance.js";
import { regionCellSize, regionGridSize, regionSpan } from "../format.js";
import { VoxelKind } from "./block-palette.js";
import type { ChunkVoxelReader } from "./chunk-voxels.js";
import { VoxelBox, isOpaqueKind } from "./voxel-box.js";

/** Rock under the part of a chunk that was read, where a cliff or the world edge shows it. */
const DEEP_ROCK = rgb(118, 116, 112);

/**
 * The voxels of one level 1 to 5 region and a margin of its neighbors. Voxels are cubes
 * `voxelSize` blocks wide, and the region itself is `span` voxels across.
 */
export interface VoxelRegion {
  readonly level: number;
  readonly x: number;
  readonly z: number;
  readonly voxelSize: number;
  readonly span: number;
  /** Voxels of neighboring regions on each side, for culling, occlusion, and sky tracing. */
  readonly margin: number;
  /** World y of the box's first layer. */
  readonly low: number;
  readonly box: VoxelBox;
  /** 1 for each box column inside a stored chunk. Other columns are unexplored land. */
  readonly explored: Uint8Array;
}

interface PlacedChunk {
  /** Box column of the chunk's first voxel. */
  readonly x: number;
  readonly z: number;
  readonly low: number;
  readonly box: VoxelBox;
}

/** Reads and merges a region's voxels. Returns undefined when the region itself stores no chunk. */
export function buildVoxelRegion(
  reader: ChunkVoxelReader,
  level: number,
  regionX: number,
  regionZ: number,
): VoxelRegion | undefined {
  const voxelSize = regionCellSize(level);
  const span = regionGridSize(level);
  // At least one chunk of margin, and two voxels where voxels are wider than half a chunk.
  const marginBlocks = Math.max(16, voxelSize * 2);
  const margin = marginBlocks / voxelSize;
  const firstChunkX = (regionX * regionSpan(level) - marginBlocks) / 16;
  const firstChunkZ = (regionZ * regionSpan(level) - marginBlocks) / 16;
  const chunksPerSide = (regionSpan(level) + marginBlocks * 2) / 16;
  const marginChunks = marginBlocks / 16;
  const chunkVoxels = 16 / voxelSize;

  const placed: PlacedChunk[] = [];
  let regionHasChunks = false;
  for (let row = 0; row < chunksPerSide; row += 1) {
    for (let column = 0; column < chunksPerSide; column += 1) {
      const chunk = reader.read(firstChunkX + column, firstChunkZ + row, voxelSize);
      if (chunk === undefined) continue;
      regionHasChunks ||=
        row >= marginChunks &&
        row < chunksPerSide - marginChunks &&
        column >= marginChunks &&
        column < chunksPerSide - marginChunks;
      placed.push({ x: column * chunkVoxels, z: row * chunkVoxels, ...chunk });
    }
  }
  if (!regionHasChunks) return undefined;

  const low = Math.min(...placed.map((chunk) => chunk.low));
  const high = Math.max(...placed.map((chunk) => chunk.low + chunk.box.layers * voxelSize));
  const box = new VoxelBox(span + margin * 2, (high - low) / voxelSize);
  const explored = new Uint8Array(box.width * box.width);
  for (const chunk of placed) {
    placeChunk(box, chunk, (chunk.low - low) / voxelSize);
    for (let z = 0; z < chunkVoxels; z += 1) {
      explored.fill(
        1,
        (chunk.z + z) * box.width + chunk.x,
        (chunk.z + z) * box.width + chunk.x + chunkVoxels,
      );
    }
  }
  return { level, x: regionX, z: regionZ, voxelSize, span, margin, low, box, explored };
}

/** Copies a chunk into the region box, and fills the layers below it with its deepest voxels. */
function placeChunk(box: VoxelBox, chunk: PlacedChunk, firstLayer: number): void {
  const source = chunk.box;
  for (let z = 0; z < source.width; z += 1) {
    for (let x = 0; x < source.width; x += 1) {
      for (let layer = 0; layer < source.layers; layer += 1) {
        const from = source.index(x, layer, z);
        if (source.kind[from] === VoxelKind.Air) continue;
        box.copy(source, from, box.index(chunk.x + x, firstLayer + layer, chunk.z + z));
      }

      const deepest = source.index(x, 0, z);
      const solidBelow = isOpaqueKind(source.kind[deepest]!);
      for (let layer = 0; layer < firstLayer; layer += 1) {
        const to = box.index(chunk.x + x, layer, chunk.z + z);
        if (solidBelow) {
          box.copy(source, deepest, to);
        } else {
          box.kind[to] = VoxelKind.Solid;
          box.top[to] = DEEP_ROCK;
          box.side[to] = DEEP_ROCK;
          box.fill[to] = 16;
        }
      }
    }
  }
}
