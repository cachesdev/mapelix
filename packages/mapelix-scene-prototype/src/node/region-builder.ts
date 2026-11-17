import { EMPTY_HEIGHT, encodeSceneRegion, regionGridSize, type SceneRegion } from "../format.js";
import { WorldDatabase } from "../leveldb/world-database.js";
import { BlockPalette, type PaletteTextures } from "../mesh/block-palette.js";
import { ChunkVoxelReader } from "../mesh/chunk-voxels.js";
import { buildRegionVolume } from "../mesh/region-volume.js";
import { meshVoxelRegion } from "../mesh/voxel-level-mesher.js";
import { meshRegionVolume } from "../mesh/voxel-mesher.js";
import { buildVoxelRegion } from "../mesh/voxel-region.js";
import { ChunkSource, type Dimension } from "../world/chunk-source.js";
import { CAVE_LIMITS, sceneContext, type SceneContextOptions } from "../dimensions.js";
import { buildDiscoveryIndex } from "../world/discovery-index.js";
import type { DiscoveryRequest } from "../discoveries.js";

export interface RegionRequest extends SceneContextOptions {
  /** Exclusive upper mesh bound, in multiples of 16. Defaults to the dimension profile. */
  readonly ceilingY?: number;
  readonly level: number;
  readonly x: number;
  readonly z: number;
  /**
   * Builds a textured level 0 region with this atlas index. Between a pool and its workers the
   * index travels once; later requests name it by its fingerprint.
   */
  readonly textures?: PaletteTextures | string;
  /**
   * With `textures`: draw the faces behind blocks with holes, such as leaves, which a textured
   * view cuts out (detailed leaves). Plain and fast textured regions leave them out.
   */
  readonly cutout?: boolean;
}

export interface RegionBuilderOptions {
  readonly directory: string;
  readonly dimension: Dimension;
}

/**
 * Builds serialized scene regions from one world. Each worker thread owns one
 * builder, so its database handles, block cache, and palette are never shared.
 */
export class RegionBuilder {
  private readonly database: WorldDatabase;
  private readonly chunks: ChunkSource;
  private readonly voxels: ChunkVoxelReader;
  private readonly palette = new BlockPalette();
  /** The palette of the last texture index received, kept while requests name it. */
  private textured: BlockPalette | undefined;

  constructor(options: RegionBuilderOptions) {
    this.database = WorldDatabase.open(options.directory);
    this.chunks = new ChunkSource(this.database, options.dimension);
    this.voxels = new ChunkVoxelReader(this.chunks, this.palette);
  }

  build(request: RegionRequest): Uint8Array {
    return encodeSceneRegion(this.mesh(request));
  }

  /** Snapshot-based source indexing shares the worker/reader, independently of terrain meshing. */
  discoveries(request: DiscoveryRequest): Uint8Array {
    return buildDiscoveryIndex(this.chunks, request);
  }

  close(): void {
    this.database.close();
  }

  private paletteFor(textures: PaletteTextures | string | undefined): BlockPalette {
    if (textures === undefined) return this.palette;
    if (typeof textures === "string") {
      if (this.textured?.textures?.fingerprint !== textures) {
        throw new Error(`Texture index ${textures} was not received`);
      }
      return this.textured;
    }
    if (this.textured?.textures?.fingerprint !== textures.fingerprint) {
      this.textured = new BlockPalette(textures);
    }
    return this.textured;
  }

  private mesh(request: RegionRequest): SceneRegion {
    const { level, x, z } = request;
    const config = this.chunks.config;
    const context = sceneContext(config.dimension, request);
    if (
      context.mode === "caves" &&
      (!Number.isInteger(level) || level < 0 || level > CAVE_LIMITS.maxLevel)
    ) {
      throw new RangeError(`Caves support LOD 0 through ${CAVE_LIMITS.maxLevel}`);
    }
    const window = context.mode === "caves" ? context : undefined;
    const geometry =
      window === undefined
        ? config.geometry
        : config.geometry === "islands"
          ? "islands"
          : "interior";
    const palette = this.paletteFor(request.textures);
    if (palette !== this.palette && level !== 0) {
      throw new RangeError("Only level 0 regions are textured");
    }
    if (request.cutout === true && palette === this.palette) {
      throw new RangeError("Detailed cut-out regions need textures");
    }
    if (level === 0) {
      const volume = buildRegionVolume(this.chunks, palette, x, z, context.maxY, window);
      return volume === undefined
        ? emptyRegion(level, x, z, palette !== this.palette)
        : meshRegionVolume(volume, palette, x, z, geometry, request.cutout === true);
    }
    const voxels = buildVoxelRegion(this.voxels, level, x, z, context.maxY, window);
    return voxels === undefined ? emptyRegion(level, x, z) : meshVoxelRegion(voxels, geometry);
  }
}

function emptyRegion(level: number, x: number, z: number, textured = false): SceneRegion {
  const empty = new Uint32Array(0);
  return {
    level,
    x,
    z,
    heights: new Int16Array(regionGridSize(level) ** 2).fill(EMPTY_HEIGHT),
    minY: 0,
    maxY: 0,
    opaque: empty,
    plants: empty,
    translucent: empty,
    ...(textured ? { textures: { opaque: empty, plants: empty, translucent: empty } } : {}),
  };
}
