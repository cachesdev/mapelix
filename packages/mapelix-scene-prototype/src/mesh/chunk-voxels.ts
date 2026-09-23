import { Face, WORLD_MAX_Y, WORLD_MIN_Y } from "../format.js";
import { decodeSection, type ChunkSource } from "../world/chunk-source.js";
import { biomeTints } from "./biome-tints.js";
import {
  BlockPalette,
  PALETTE_ID_MASK,
  TintCode,
  VoxelKind,
  WATERLOGGED,
} from "./block-palette.js";
import { sectionCells } from "./region-volume.js";
import { COVER_DEPTH } from "./voxel-faces.js";
import { VoxelBox, halveVoxels, isOpaqueKind } from "./voxel-box.js";

/** Water under water fills its voxel; the top water block sits two sixteenths lower. */
const WATER_SURFACE_FILL = 14;
/**
 * Voxels this wide or wider read only `COARSE_DEPTH` blocks into the ground. Caves
 * deeper than that are smaller than a pixel where these voxels are drawn.
 */
const COARSE_VOXEL = 4;
const COARSE_DEPTH = 16;
/**
 * Ground is at least this many opaque blocks thick. Thinner floors, roofs, and platforms
 * can float over open air, so the reader keeps reading below them.
 */
const GROUND_THICKNESS = 4;

/**
 * The part of a chunk that can show a face: from its highest stored subchunk down to
 * `COVER_DEPTH` below its lowest ground, or `COARSE_DEPTH` for coarse voxels. Deeper
 * blocks count as rock. `low` is the world y of the box's first layer, a multiple of 16.
 */
export interface ChunkVoxels {
  readonly low: number;
  readonly box: VoxelBox;
}

interface StoredSection {
  readonly y: number;
  readonly cells: Uint16Array;
  /** Highest local y that holds anything but air. */
  readonly top: number;
}

/** Reads chunks into voxels, decoding subchunks from the top down only as deep as needed. */
export class ChunkVoxelReader {
  private readonly chunks: ChunkSource;
  private readonly palette: BlockPalette;
  /** Boxes that live only until they are halved, reused to spare the garbage collector. */
  private readonly scratch = new Map<number, VoxelBox>();
  /** Per column while writing: the color of a thin layer above, or -1. */
  private readonly layerColor = new Int32Array(256);
  /** Per column while writing: 1 when the block above is water. */
  private readonly waterAbove = new Uint8Array(256);

  constructor(chunks: ChunkSource, palette: BlockPalette) {
    this.chunks = chunks;
    this.palette = palette;
  }

  /** Reads a chunk as voxels `voxelSize` blocks wide, a power of two up to 16. */
  read(chunkX: number, chunkZ: number, voxelSize: number): ChunkVoxels | undefined {
    const records = this.chunks.records(chunkX, chunkZ);
    if (records === undefined) return undefined;

    const sections: StoredSection[] = [];
    // Leaves are not ground: the air under a canopy must be read.
    const ground = new Int16Array(256).fill(WORLD_MIN_Y - 1);
    const depth = voxelSize >= COARSE_VOXEL ? COARSE_DEPTH : COVER_DEPTH;
    let open = 256;
    for (const record of records.sections) {
      const section = decodeSection(record);
      if (section === undefined || section.y < WORLD_MIN_Y / 16 || section.y >= WORLD_MAX_Y / 16) {
        continue;
      }
      const cells = sectionCells(section, this.palette);
      const top = this.highestFilled(cells);
      if (top === -1) continue;
      sections.push({ y: section.y, cells, top });
      open -= this.findGround(cells, section.y * 16, ground);
      if (open === 0 && section.y * 16 <= Math.min(...ground) - depth - 1) break;
    }
    if (sections.length === 0) return undefined;

    const low = sections.at(-1)!.y * 16;
    const layers = (sections[0]!.y + 1) * 16 - low;
    let box = this.box(16, layers, voxelSize === 1);
    const tints = Array.from({ length: 256 }, (_, column) => {
      const surface = ground[column]! < WORLD_MIN_Y ? 64 : ground[column]!;
      return biomeTints(records.biomes.at(column & 15, surface, column >> 4));
    });
    this.writeSections(box, sections, low, tints);
    box.filled = sections[0]!.y * 16 + sections[0]!.top + 1 - low;
    for (let size = 2; size <= voxelSize; size *= 2) {
      box = halveVoxels(box, this.box(16 / size, layers / size, size === voxelSize));
    }
    return { low, box };
  }

  /** A new box when the caller keeps it, or an emptied scratch box otherwise. */
  private box(width: number, layers: number, kept: boolean): VoxelBox {
    if (kept) return new VoxelBox(width, layers);
    const key = width * 1024 + layers;
    const reused = this.scratch.get(key);
    if (reused === undefined) {
      const box = new VoxelBox(width, layers);
      this.scratch.set(key, box);
      return box;
    }
    reused.clear();
    return reused;
  }

  /**
   * Records the highest ground of each column that has none yet: the top of a run of
   * `GROUND_THICKNESS` opaque blocks. Runs do not continue across subchunks, so ground
   * at the bottom of a subchunk is found a little lower. Returns how many it found.
   */
  private findGround(cells: Uint16Array, baseY: number, ground: Int16Array): number {
    const { voxel } = this.palette;
    let found = 0;
    for (let column = 0; column < 256; column += 1) {
      if (ground[column]! >= WORLD_MIN_Y) continue;
      const start = (column & 15) * 256 + (column >> 4) * 16;
      let run = 0;
      for (let y = 15; y >= 0; y -= 1) {
        const kind = voxel[cells[start + y]! & PALETTE_ID_MASK]!;
        run = isOpaqueKind(kind) && kind !== VoxelKind.Foliage ? run + 1 : 0;
        if (run < GROUND_THICKNESS) continue;
        ground[column] = baseY + y + GROUND_THICKNESS - 1;
        found += 1;
        break;
      }
    }
    return found;
  }

  /**
   * Writes the subchunks from the top down, one layer at a time, with the biome tints of
   * each column. Thin layers such as snow and carpets become the top color of the block
   * below them.
   */
  private writeSections(
    box: VoxelBox,
    sections: readonly StoredSection[],
    low: number,
    tints: readonly Uint32Array[],
  ): void {
    const { voxel, covered } = this.palette;
    const { kind: kinds, top: tops, side: sides, fill, covered: soils } = box;
    const { layerColor, waterAbove } = this;
    let previous = Number.POSITIVE_INFINITY;
    for (const section of sections) {
      // A missing subchunk is air, which ends any layer or water above it.
      if (section.y !== previous - 1) {
        layerColor.fill(-1);
        waterAbove.fill(0);
      }
      previous = section.y;
      const { cells } = section;
      if (section.top < 15) {
        layerColor.fill(-1);
        waterAbove.fill(0);
      }
      for (let y = section.top; y >= 0; y -= 1) {
        let index = (section.y * 16 + y - low) * 256;
        for (let column = 0; column < 256; column += 1, index += 1) {
          // Box columns run z * 16 + x; Bedrock stores blocks as x * 256 + z * 16 + y.
          const cell = cells[((column & 15) << 8) | ((column >> 4) << 4) | y]!;
          const id = cell & PALETTE_ID_MASK;
          let kind = voxel[id]!;
          // Water fills the gaps of waterlogged plants, fences, and other open blocks.
          if ((cell & WATERLOGGED) !== 0 && (kind === VoxelKind.Air || kind === VoxelKind.Layer)) {
            kind = VoxelKind.Water;
          }
          if (kind === VoxelKind.Layer) {
            layerColor[column] = this.faceColor(id, Face.PositiveY, tints[column]!);
            waterAbove[column] = 0;
            continue;
          }
          if (kind === VoxelKind.Water) {
            const water = tints[column]![TintCode.Water]!;
            tops[index] = water;
            sides[index] = water;
            fill[index] = waterAbove[column] === 1 ? 16 : WATER_SURFACE_FILL;
          } else if (kind !== VoxelKind.Air) {
            const soil = covered[id]!;
            const layered = layerColor[column]!;
            const top =
              layered === -1 ? this.faceColor(id, Face.PositiveY, tints[column]!) : layered;
            tops[index] = top;
            // Covered sides keep the color of their strip; the shader draws the soil below it.
            sides[index] = soil === 1 ? top : this.faceColor(id, Face.PositiveX, tints[column]!);
            soils[index] = soil;
            fill[index] = 16;
          }
          kinds[index] = kind;
          layerColor[column] = -1;
          waterAbove[column] = kind === VoxelKind.Water ? 1 : 0;
        }
      }
    }
  }

  /** The highest local y of a subchunk that holds anything but air, or -1 when it is empty. */
  private highestFilled(cells: Uint16Array): number {
    const { voxel } = this.palette;
    let top = -1;
    for (let index = 0; index < 4096; index += 1) {
      const cell = cells[index]!;
      if (cell === 0 || (index & 15) <= top) continue;
      if ((cell & WATERLOGGED) !== 0 || voxel[cell & PALETTE_ID_MASK] !== VoxelKind.Air) {
        top = index & 15;
      }
    }
    return top;
  }

  private faceColor(id: number, face: number, tints: Uint32Array): number {
    const tint = this.palette.tints[id * 6 + face]!;
    return tint === TintCode.None ? this.palette.colors[id * 6 + face]! : tints[tint]!;
  }
}
