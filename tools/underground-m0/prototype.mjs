import { RegionBuilder } from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/node/region-builder.js";
import { buildRegionVolume } from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/mesh/region-volume.js";
import { meshRegionVolume } from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/mesh/voxel-mesher.js";
import { buildVoxelRegion } from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/mesh/voxel-region.js";
import { meshVoxelRegion } from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/mesh/voxel-level-mesher.js";
import {
  state,
  configure,
  ALLOC_MIN_Y,
  ALLOC_MAX_Y,
} from "../../packages/mapelix-scene-prototype/.local/underground-m0-dist/mesh/m0-range.js";
import {
  DIMENSIONS,
  sceneContext,
} from "../../packages/mapelix-scene-prototype/dist/dimensions.js";
import {
  EMPTY_HEIGHT,
  Face,
  encodeSceneRegion,
  unpackQuad,
  packQuadWord0,
  packQuadWord1,
  regionCellSize,
  regionGridSize,
} from "../../packages/mapelix-scene-prototype/dist/format.js";

export function context(dimension, request) {
  const config = DIMENSIONS[dimension];
  if (!config) throw new RangeError("Unknown dimension");
  const mode = request.mode ?? "default";
  if (mode !== "default" && mode !== "caves")
    throw new RangeError("Unknown mode");
  if (
    request.maxY !== undefined &&
    request.ceilingY !== undefined &&
    request.maxY !== request.ceilingY
  )
    throw new RangeError("Conflicting maxY and ceilingY");
  const minY = request.minY ?? config.minY;
  const maxY = request.maxY ?? request.ceilingY ?? config.defaultCeilingY;
  if (
    ![minY, maxY].every(Number.isSafeInteger) ||
    minY < config.minY ||
    maxY > config.maxY ||
    minY >= maxY
  )
    throw new RangeError("Invalid exclusive window");
  if (mode === "default") {
    sceneContext(dimension, maxY);
    if (minY !== config.minY)
      throw new RangeError("M0 default path retains the original floor");
  } else if (minY % 8 !== 0 || maxY % 8 !== 0)
    throw new RangeError("M0 exploratory windows align to eight blocks");
  return { dimension, mode, minY, maxY };
}
export function key(dimension, request) {
  const c = context(dimension, request);
  return `${c.dimension}/${c.mode}/${c.minY}/${c.maxY}/${request.level}/${request.x}/${request.z}`;
}
export class PrototypeBuilder {
  constructor(directory, dimension) {
    this.dimension = dimension;
    this.config = DIMENSIONS[dimension];
    this.legacy = new RegionBuilder({ directory, dimension });
    // Reuse one database, palette and reader between views, matching the intended worker ownership.
    this.database = this.legacy.database;
    this.chunks = this.legacy.chunks;
    this.palette = this.legacy.palette;
    this.reader = this.legacy.voxels;
  }
  close() {
    this.legacy.close();
  }
  build(request) {
    const c = context(this.dimension, request);
    configure(
      c.mode === "caves",
      c.minY,
      c.maxY,
      this.config.minY,
      this.config.maxY,
    );
    if (c.mode === "default")
      return this.legacy.build({
        level: request.level,
        x: request.x,
        z: request.z,
        ceilingY: c.maxY,
      });
    const started = performance.now();
    let region;
    if (request.level === 0) {
      const volume = buildRegionVolume(
        this.chunks,
        this.palette,
        request.x,
        request.z,
        ALLOC_MAX_Y,
      );
      const decoded = performance.now();
      region =
        volume &&
        meshRegionVolume(
          volume,
          this.palette,
          request.x,
          request.z,
          this.dimension === "the-end" ? "islands" : "interior",
        );
      this.timings = {
        volumeMs: decoded - started,
        meshMs: performance.now() - decoded,
      };
    } else {
      const volume = buildVoxelRegion(
        this.reader,
        request.level,
        request.x,
        request.z,
        ALLOC_MAX_Y,
      );
      const decoded = performance.now();
      region =
        volume &&
        meshVoxelRegion(
          volume,
          this.dimension === "the-end" ? "islands" : "interior",
        );
      this.timings = {
        volumeMs: decoded - started,
        meshMs: performance.now() - decoded,
      };
    }
    if (!region) region = empty(request);
    region = crop(region, c.minY, c.maxY);
    this.timings.allocatedMinY = ALLOC_MIN_Y;
    this.timings.allocatedMaxY = ALLOC_MAX_Y;
    this.timings.sectionHits = state.sectionHits;
    this.timings.sectionMisses = state.sectionMisses;
    return encodeSceneRegion(region);
  }
}
export function empty(request) {
  return {
    ...request,
    heights: new Int16Array(regionGridSize(request.level) ** 2).fill(
      EMPTY_HEIGHT,
    ),
    minY: 0,
    maxY: 0,
    opaque: new Uint32Array(0),
    plants: new Uint32Array(0),
    translucent: new Uint32Array(0),
  };
}
function crop(region, minY, maxY) {
  const size = regionCellSize(region.level),
    low = minY / size,
    high = maxY / size;
  let bottom = Infinity,
    top = -Infinity;
  function list(words) {
    const out = [];
    for (let i = 0; i < words.length / 3; i++) {
      const q = unpackQuad(words, i);
      let y = q.y,
        height = q.height;
      const flat = q.face === Face.PositiveY || q.face === Face.NegativeY;
      if (flat || q.face >= 6 || q.modelBounds) {
        if (y < low || y >= high) continue;
      } else {
        const nextY = Math.max(y, low),
          end = Math.min(y + height, high);
        if (end <= nextY) continue;
        y = nextY;
        height = end - y;
      }
      if (!Number.isInteger(y) || !Number.isInteger(height))
        throw new Error("Window not aligned to this LOD");
      const word0 =
        (packQuadWord0(q.x, y, q.z, q.face, q.material, q.coveredSoil) |
          (words[i * 3] & 0x80000000)) >>>
        0;
      const word1 =
        (packQuadWord1(q.width, height, q.box, q.sprite) |
          (words[i * 3 + 1] & 0xff000000)) >>>
        0;
      out.push(word0, word1, words[i * 3 + 2]);
      bottom = Math.min(bottom, y * size);
      top = Math.max(top, (y + (flat ? 1 : height)) * size);
    }
    return Uint32Array.from(out);
  }
  const opaque = list(region.opaque),
    plants = list(region.plants),
    translucent = list(region.translucent);
  return {
    ...region,
    opaque,
    plants,
    translucent,
    minY: Number.isFinite(bottom) ? bottom : 0,
    maxY: Number.isFinite(top) ? top : 0,
    heights: region.heights.map((y) =>
      y === EMPTY_HEIGHT || y <= minY ? EMPTY_HEIGHT : Math.min(y, maxY),
    ),
  };
}
