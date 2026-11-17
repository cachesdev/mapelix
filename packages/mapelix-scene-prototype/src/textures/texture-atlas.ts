import { createHash } from "node:crypto";

import {
  ATLAS_FORMAT_VERSION,
  MAX_ATLAS_SIDE,
  MAX_ATLAS_TILES,
  atlasBytes,
  atlasLevelCount,
  atlasLevelSize,
  encodeTextureAtlas,
  type AtlasTileInfo,
  type TextureAtlas,
} from "./atlas-format.js";
import type { TextureNames } from "./block-textures.js";
import type { PackImage } from "./pack-image.js";
import type {
  BlockTextureNames,
  Flipbook,
  ResourcePackStack,
  TerrainEntry,
} from "./resource-pack.js";

export interface TextureAtlasOptions {
  /** Largest tile side; larger textures are averaged down (default 32). */
  readonly maxTileSize?: number;
  /** GPU bytes the atlas and its mipmaps may take; tiles shrink until it fits (default 32 MiB). */
  readonly budgetBytes?: number;
}

/**
 * What a region builder needs to texture blocks: the merged block and terrain entries of the
 * stack and the atlas tile of each image. Plain data, so it crosses to worker threads.
 */
export interface TextureIndex {
  readonly fingerprint: string;
  readonly tiles: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, BlockTextureNames>>;
  readonly terrain: Readonly<Record<string, TerrainEntry>>;
}

export interface BuiltTextureAtlas {
  /** Names the atlas and every region textured with it: the stack fingerprint and the layout. */
  readonly fingerprint: string;
  readonly atlas: TextureAtlas;
  readonly bytes: Uint8Array;
  readonly index: TextureIndex;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
}

export const DEFAULT_ATLAS_OPTIONS = {
  maxTileSize: 32,
  budgetBytes: 32 * 1024 * 1024,
} as const;

/** Lookups for `resolveBlockTextures` from an index. */
export function textureNames(index: TextureIndex): TextureNames {
  return {
    blockTextures: (block) => index.blocks[block],
    terrainEntry: (name) => index.terrain[name],
  };
}

interface Source {
  readonly path: string;
  readonly image: PackImage;
  readonly side: number;
  /** Frame indexes into the image's square frames, in play order. */
  readonly frames: readonly number[];
  readonly ticksPerFrame: number;
}

/** Builds the atlas of every block texture a stack defines. */
export async function buildTextureAtlas(
  stack: ResourcePackStack,
  options: TextureAtlasOptions = {},
): Promise<BuiltTextureAtlas> {
  const maxTileSize = options.maxTileSize ?? DEFAULT_ATLAS_OPTIONS.maxTileSize;
  const budgetBytes = options.budgetBytes ?? DEFAULT_ATLAS_OPTIONS.budgetBytes;
  if (!Number.isInteger(Math.log2(maxTileSize)) || maxTileSize < 1 || maxTileSize > 256) {
    throw new RangeError("maxTileSize must be a power of two up to 256");
  }

  // The merged entries: each block and terrain name from the first pack defining it.
  const blocks: Record<string, BlockTextureNames> = {};
  const terrain: Record<string, TerrainEntry> = {};
  const flipbooks = new Map<string, Flipbook>();
  for (const pack of stack.packs) {
    for (const name of pack.blocks.keys()) {
      if (Object.hasOwn(blocks, name)) continue;
      const faces = stack.blockTextures(name)!;
      blocks[name] = faces;
      for (const textureName of new Set(Object.values(faces))) {
        if (Object.hasOwn(terrain, textureName)) continue;
        const entry = stack.terrainEntry(textureName);
        if (entry === undefined) continue;
        terrain[textureName] = entry;
        const flipbook = stack.flipbook(textureName);
        if (flipbook !== undefined) flipbooks.set(flipbook.path, flipbook);
      }
    }
  }
  const paths = [
    ...new Set(Object.values(terrain).flatMap((entry) => entry.textures.map((ref) => ref.path))),
  ].sort();

  const sources: Source[] = [];
  for (const path of paths) {
    const image = await stack.readImage(path);
    if (image === undefined) continue;
    const side = Math.min(image.width, image.height);
    const flipbook = flipbooks.get(path);
    const available = Math.floor(image.height / side);
    const frames =
      flipbook === undefined
        ? [0]
        : (flipbook.frames ?? Array.from({ length: available }, (_, frame) => frame)).filter(
            (frame) => frame < available,
          );
    sources.push({
      path,
      image,
      side,
      frames: frames.length === 0 ? [0] : frames,
      ticksPerFrame: flipbook?.ticksPerFrame ?? 1,
    });
  }
  const count = sources.reduce((sum, source) => sum + source.frames.length, 0);
  if (count === 0) throw new RangeError("The resource packs hold no block texture");
  if (count > MAX_ATLAS_TILES) {
    throw new RangeError(
      `The resource packs hold ${count} block textures, more than ${MAX_ATLAS_TILES}`,
    );
  }

  // The tile size is the most common texture size, bounded by the options and the budget.
  const sides = new Map<number, number>();
  for (const source of sources)
    sides.set(source.side, (sides.get(source.side) ?? 0) + source.frames.length);
  const common = [...sides].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  let tileSize = 2 ** Math.floor(Math.log2(Math.min(common, maxTileSize)));
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  while (
    tileSize > 1 &&
    (atlasBytes({ tileSize, columns, rows }) > budgetBytes ||
      columns * tileSize > MAX_ATLAS_SIDE ||
      rows * tileSize > MAX_ATLAS_SIDE)
  ) {
    tileSize /= 2;
  }

  const { width } = atlasLevelSize({ tileSize, columns, rows }, 0);
  const base = new Uint8Array(width * rows * tileSize * 4);
  const tiles: AtlasTileInfo[] = [];
  const tileOf: Record<string, number> = {};
  for (const source of sources) {
    tileOf[source.path] = tiles.length;
    for (const [order, frame] of source.frames.entries()) {
      const tile = tiles.length;
      const x0 = (tile % columns) * tileSize;
      const y0 = Math.floor(tile / columns) * tileSize;
      const average = resample(source.image, source.side, frame, tileSize, base, width, x0, y0);
      tiles.push({
        ...average,
        frames: order === 0 ? source.frames.length : 0,
        ticksPerFrame: Math.min(255, source.ticksPerFrame),
      });
    }
  }

  const levels: Uint8Array[] = [base];
  for (let level = 1; level < atlasLevelCount(tileSize); level++) {
    levels.push(halve(levels[level - 1]!, atlasLevelSize({ tileSize, columns, rows }, level - 1)));
  }
  const atlas: TextureAtlas = { tileSize, columns, rows, tiles, levels };
  const fingerprint = createHash("sha256")
    .update(`mapelix-atlas-v${ATLAS_FORMAT_VERSION}\0${stack.fingerprint}\0${tileSize}\0${columns}`)
    .digest("hex")
    .slice(0, 20);
  return {
    fingerprint,
    atlas,
    bytes: encodeTextureAtlas(atlas),
    index: { fingerprint, tiles: tileOf, blocks, terrain },
    gpuBytes: atlasBytes(atlas),
  };
}

/**
 * Writes one square frame of `image`, scaled to `tileSize`, into the atlas at `(x0, y0)`.
 * Larger frames are averaged by alpha-weighted boxes, smaller ones repeat their pixels.
 * Returns the frame's average color and coverage.
 */
function resample(
  image: PackImage,
  side: number,
  frame: number,
  tileSize: number,
  out: Uint8Array,
  outWidth: number,
  x0: number,
  y0: number,
): { average: number; coverage: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumA = 0;
  for (let y = 0; y < tileSize; y++) {
    const fromY = Math.floor((y * side) / tileSize);
    const toY = Math.max(fromY + 1, Math.floor(((y + 1) * side) / tileSize));
    for (let x = 0; x < tileSize; x++) {
      const fromX = Math.floor((x * side) / tileSize);
      const toX = Math.max(fromX + 1, Math.floor(((x + 1) * side) / tileSize));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let plainR = 0;
      let plainG = 0;
      let plainB = 0;
      for (let sy = fromY; sy < toY; sy++) {
        const row = (frame * side + sy) * image.width;
        for (let sx = fromX; sx < toX; sx++) {
          const at = (row + sx) * 4;
          const alpha = image.rgba[at + 3]!;
          r += image.rgba[at]! * alpha;
          g += image.rgba[at + 1]! * alpha;
          b += image.rgba[at + 2]! * alpha;
          a += alpha;
          plainR += image.rgba[at]!;
          plainG += image.rgba[at + 1]!;
          plainB += image.rgba[at + 2]!;
        }
      }
      const samples = (toY - fromY) * (toX - fromX);
      const at = ((y0 + y) * outWidth + x0 + x) * 4;
      out[at] = Math.round(a > 0 ? r / a : plainR / samples);
      out[at + 1] = Math.round(a > 0 ? g / a : plainG / samples);
      out[at + 2] = Math.round(a > 0 ? b / a : plainB / samples);
      out[at + 3] = Math.round(a / samples);
      sumR += out[at]! * out[at + 3]!;
      sumG += out[at + 1]! * out[at + 3]!;
      sumB += out[at + 2]! * out[at + 3]!;
      sumA += out[at + 3]!;
    }
  }
  const pixels = tileSize * tileSize;
  const channel = (sum: number): number => (sumA > 0 ? Math.round(sum / sumA) : 0);
  return {
    average: (channel(sumR) << 16) | (channel(sumG) << 8) | channel(sumB),
    coverage: Math.round(sumA / pixels),
  };
}

/** The next mipmap level: alpha-weighted 2×2 averages, which never cross a tile border. */
function halve(pixels: Uint8Array, size: { width: number; height: number }): Uint8Array {
  const width = size.width / 2;
  const height = size.height / 2;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let plain = [0, 0, 0];
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const at = ((2 * y + dy) * size.width + 2 * x + dx) * 4;
        const alpha = pixels[at + 3]!;
        r += pixels[at]! * alpha;
        g += pixels[at + 1]! * alpha;
        b += pixels[at + 2]! * alpha;
        a += alpha;
        plain = [plain[0]! + pixels[at]!, plain[1]! + pixels[at + 1]!, plain[2]! + pixels[at + 2]!];
      }
      const at = (y * width + x) * 4;
      out[at] = Math.round(a > 0 ? r / a : plain[0]! / 4);
      out[at + 1] = Math.round(a > 0 ? g / a : plain[1]! / 4);
      out[at + 2] = Math.round(a > 0 ? b / a : plain[2]! / 4);
      out[at + 3] = Math.round(a / 4);
    }
  }
  return out;
}
