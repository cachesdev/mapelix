import { createHash } from "node:crypto";

import {
  isCutoutTile,
  ATLAS_FORMAT_VERSION,
  MAX_ATLAS_SIDE,
  MAX_ATLAS_TILES,
  MIN_ATLAS_TILE,
  atlasBytes,
  atlasCellSize,
  atlasGutter,
  atlasLevelCount,
  atlasLevelSize,
  encodeTextureAtlas,
  type AtlasTileInfo,
  type TextureAtlas,
} from "./atlas-format.js";
import type { TextureNames } from "./block-textures.js";
import type { PackImage } from "./pack-image.js";
import { BANNER_TEXTURE, BANNER_TILE, bannerTileSide, cutBannerTile } from "./banner-tile.js";
import {
  BED_COLORS,
  BED_TILES,
  bedTexturePath,
  bedTilePath,
  cutBedTile,
  type BedTile,
} from "./bed-tiles.js";
import type {
  BlockTextureNames,
  Flipbook,
  ResourcePack,
  ResourcePackInfo,
  ResourcePackStack,
  SkippedImage,
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
  /** Tiles with holes (`isCutoutTile`), ascending. */
  readonly cutout: readonly number[];
}

/** Packs and files an atlas was made of, for attribution. */
export interface TextureNotice {
  readonly pack: ResourcePackInfo;
  /** Image files of the pack in the atlas, sorted. */
  readonly files: readonly string[];
}

export interface BuiltTextureAtlas {
  /** The texture revision (`textureRevision`): names the atlas and every region textured with it. */
  readonly fingerprint: string;
  readonly atlas: TextureAtlas;
  readonly bytes: Uint8Array;
  readonly index: TextureIndex;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
  readonly notices: readonly TextureNotice[];
  /** Images the packs hold but the atlas could not use, replaced by the next pack's if any. */
  readonly skipped: readonly SkippedImage[];
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
  readonly side: number;
  /** Frame indexes into the image's square frames, in play order. */
  readonly frames: readonly number[];
  readonly ticksPerFrame: number;
  /** The image's alpha is an overlay mask, see `AtlasTileInfo.overlay`. */
  readonly overlay: boolean;
  /** A tile cut from a bed's entity texture (see `cutBedTile`), read from `image`. */
  readonly bed?: { readonly image: string; readonly tile: BedTile };
  readonly banner?: true;
}

function atlasOptions(options: TextureAtlasOptions): Required<TextureAtlasOptions> {
  const maxTileSize = options.maxTileSize ?? DEFAULT_ATLAS_OPTIONS.maxTileSize;
  const budgetBytes = options.budgetBytes ?? DEFAULT_ATLAS_OPTIONS.budgetBytes;
  if (
    !Number.isInteger(Math.log2(maxTileSize)) ||
    maxTileSize < MIN_ATLAS_TILE ||
    maxTileSize > 256
  ) {
    throw new RangeError("maxTileSize must be a power of two from 4 to 256");
  }
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1) {
    throw new RangeError("budgetBytes must be a positive integer");
  }
  return { maxTileSize, budgetBytes };
}

/**
 * The texture revision: names the atlas and every region textured with it. It follows from the
 * stack fingerprint and the options alone, so it is known before the atlas is built.
 */
export function textureRevision(
  stackFingerprint: string,
  options: TextureAtlasOptions = {},
): string {
  const { maxTileSize, budgetBytes } = atlasOptions(options);
  return createHash("sha256")
    .update(
      ["mapelix-atlas", ATLAS_FORMAT_VERSION, stackFingerprint, maxTileSize, budgetBytes].join("|"),
    )
    .digest("hex")
    .slice(0, 20);
}

/**
 * Builds the atlas of every block texture a stack defines. Images are read twice, once for
 * their size and once to draw them, so only one decoded image is in memory at a time.
 */
export async function buildTextureAtlas(
  stack: ResourcePackStack,
  options: TextureAtlasOptions = {},
): Promise<BuiltTextureAtlas> {
  const { maxTileSize, budgetBytes } = atlasOptions(options);

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
  const overlays = new Set(
    Object.values(terrain).flatMap((entry) =>
      entry.textures.flatMap((ref) => (ref.overlay === true ? [ref.path] : [])),
    ),
  );

  const sources: Source[] = [];
  for (const path of paths) {
    const size = await stack.readImageSize(path);
    if (size === undefined) continue;
    const side = Math.min(size.width, size.height);
    const flipbook = flipbooks.get(path);
    const available = Math.floor(size.height / side);
    const frames =
      flipbook === undefined
        ? [0]
        : (flipbook.frames ?? Array.from({ length: available }, (_, frame) => frame)).filter(
            (frame) => frame < available,
          );
    sources.push({
      path,
      side,
      frames: frames.length === 0 ? [0] : frames,
      ticksPerFrame: flipbook?.ticksPerFrame ?? 1,
      overlay: overlays.has(path),
    });
  }
  // Beds are entities in the game; their block tiles are cut from the entity textures.
  for (const color of BED_COLORS) {
    const image = bedTexturePath(color);
    const size = await stack.readImageSize(image);
    if (size === undefined || size.width !== size.height || size.width % 64 !== 0) continue;
    for (const tile of BED_TILES)
      sources.push({
        path: bedTilePath(color, tile),
        side: size.width / 4,
        frames: [0],
        ticksPerFrame: 1,
        overlay: false,
        bed: { image, tile },
      });
  }
  const bannerSize = await stack.readImageSize(BANNER_TEXTURE);
  const bannerSide =
    bannerSize === undefined ? undefined : bannerTileSide(bannerSize.width, bannerSize.height);
  if (bannerSide !== undefined)
    sources.push({
      path: BANNER_TILE,
      side: bannerSide,
      frames: [0],
      ticksPerFrame: 1,
      overlay: false,
      banner: true,
    });
  const count = sources.reduce((sum, source) => sum + source.frames.length, 0);
  if (count === 0) throw new RangeError("The resource packs hold no block texture");
  if (count > MAX_ATLAS_TILES) {
    throw new RangeError(
      `The resource packs hold ${count} block textures, more than ${MAX_ATLAS_TILES}`,
    );
  }

  // The tile size is the most common texture size, bounded by the options, the budget and the
  // largest texture every device can sample.
  const sides = new Map<number, number>();
  for (const source of sources)
    sides.set(source.side, (sides.get(source.side) ?? 0) + source.frames.length);
  const common = [...sides].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0];
  let tileSize = Math.max(
    MIN_ATLAS_TILE,
    2 ** Math.floor(Math.log2(Math.min(common, maxTileSize))),
  );
  const columns = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / columns);
  const fits = (tile: number): boolean =>
    atlasBytes({ tileSize: tile, columns, rows }) <= budgetBytes &&
    columns * atlasCellSize(tile) <= MAX_ATLAS_SIDE &&
    rows * atlasCellSize(tile) <= MAX_ATLAS_SIDE;
  while (tileSize > MIN_ATLAS_TILE && !fits(tileSize)) tileSize /= 2;
  if (!fits(tileSize)) {
    throw new RangeError(`${count} block textures do not fit in the texture budget`);
  }

  const cell = atlasCellSize(tileSize);
  const gutter = atlasGutter(tileSize);
  const { width, height } = atlasLevelSize({ tileSize, columns, rows }, 0);
  const base = new Uint8Array(width * height * 4);
  const tiles: AtlasTileInfo[] = [];
  const tileOf: Record<string, number> = {};
  const used = new Map<ResourcePack, string[]>();
  const sheetImages = new Map<string, PackImage | undefined>();
  for (const source of sources) {
    const file = source.banner ? BANNER_TEXTURE : (source.bed?.image ?? source.path);
    let image: PackImage | undefined;
    if (source.bed === undefined && !source.banner) image = await stack.readImage(file);
    else {
      if (!sheetImages.has(file)) sheetImages.set(file, await stack.readImage(file));
      const sheet = sheetImages.get(file);
      image =
        sheet === undefined
          ? undefined
          : source.banner
            ? cutBannerTile(sheet)
            : cutBedTile(sheet, source.bed!.tile);
    }
    if (image === undefined) continue;
    const found = (await stack.locateImage(file))!;
    const files = used.get(found.pack) ?? [];
    if (!files.includes(found.file)) used.set(found.pack, [...files, found.file]);
    tileOf[source.path] = tiles.length;
    // An image that failed to decode was replaced by the next pack's, which may hold fewer
    // frames than the layout counted: its frames repeat.
    const side = Math.min(image.width, image.height);
    const available = Math.max(1, Math.floor(image.height / side));
    for (const [order, wanted] of source.frames.entries()) {
      const frame = wanted % available;
      const tile = tiles.length;
      const x0 = (tile % columns) * cell + gutter;
      const y0 = Math.floor(tile / columns) * cell + gutter;
      const average = resample(image, side, frame, tileSize, base, width, x0, y0, !source.overlay);
      wrapGutter(base, width, x0, y0, tileSize, gutter);
      tiles.push({
        ...average,
        frames: order === 0 ? source.frames.length : 0,
        ticksPerFrame: Math.min(255, source.ticksPerFrame),
        ...(source.overlay ? { overlay: true } : {}),
      });
    }
  }

  const levels: Uint8Array[] = [base];
  // Overlay tiles average their colors without alpha weights, as their alpha is a mask.
  const weighted = (cellX: number, cellY: number): boolean =>
    tiles[cellY * columns + cellX]?.overlay !== true;
  for (let level = 1; level < atlasLevelCount(tileSize); level++) {
    levels.push(
      halve(
        levels[level - 1]!,
        atlasLevelSize({ tileSize, columns, rows }, level - 1),
        cell >> (level - 1),
        weighted,
      ),
    );
  }
  const atlas: TextureAtlas = { tileSize, columns, rows, tiles, levels };
  const fingerprint = textureRevision(stack.fingerprint, { maxTileSize, budgetBytes });
  return {
    fingerprint,
    atlas,
    bytes: encodeTextureAtlas(atlas),
    index: {
      fingerprint,
      tiles: tileOf,
      blocks,
      terrain,
      cutout: tiles.flatMap((tile, index) => (isCutoutTile(tile) ? [index] : [])),
    },
    gpuBytes: atlasBytes(atlas),
    notices: stack.packs
      .filter((pack) => used.has(pack))
      .map((pack) => ({ pack: pack.info, files: used.get(pack)!.sort() })),
    skipped: [...stack.skippedImages()],
  };
}

/** Fills the gutter around the tile at `(x0, y0)` with the tile repeated. */
function wrapGutter(
  pixels: Uint8Array,
  width: number,
  x0: number,
  y0: number,
  tileSize: number,
  gutter: number,
): void {
  const wrap = (value: number): number => ((value % tileSize) + tileSize) % tileSize;
  for (let y = -gutter; y < tileSize + gutter; y++) {
    for (let x = -gutter; x < tileSize + gutter; x++) {
      if (x >= 0 && x < tileSize && y >= 0 && y < tileSize) continue;
      const from = ((y0 + wrap(y)) * width + x0 + wrap(x)) * 4;
      pixels.copyWithin(((y0 + y) * width + x0 + x) * 4, from, from + 4);
    }
  }
}

/**
 * Writes one square frame of `image`, scaled to `tileSize`, into the atlas at `(x0, y0)`.
 * Larger frames are averaged by alpha-weighted boxes, smaller ones repeat their pixels.
 * `weighted` false averages colors alone, for overlay masks. Returns the frame's average color
 * and coverage.
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
  weighted = true,
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
      const byAlpha = weighted && a > 0;
      out[at] = Math.round(byAlpha ? r / a : plainR / samples);
      out[at + 1] = Math.round(byAlpha ? g / a : plainG / samples);
      out[at + 2] = Math.round(byAlpha ? b / a : plainB / samples);
      out[at + 3] = Math.round(a / samples);
      const weight = weighted ? out[at + 3]! : 255;
      sumR += out[at]! * weight;
      sumG += out[at + 1]! * weight;
      sumB += out[at + 2]! * weight;
      sumA += weight;
    }
  }
  const pixels = tileSize * tileSize;
  const channel = (sum: number): number => (sumA > 0 ? Math.round(sum / sumA) : 0);
  return {
    average: (channel(sumR) << 16) | (channel(sumG) << 8) | channel(sumB),
    coverage: Math.round(sumA / pixels),
  };
}

/**
 * The next mipmap level: alpha-weighted 2×2 averages, which never cross a tile border; plain
 * averages in cells where `weighted` is false. `cell` is the cell side at the source level.
 */
function halve(
  pixels: Uint8Array,
  size: { width: number; height: number },
  cell: number,
  weighted: (cellX: number, cellY: number) => boolean,
): Uint8Array {
  const width = size.width / 2;
  const height = size.height / 2;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const byAlpha = weighted(Math.floor((2 * x) / cell), Math.floor((2 * y) / cell));
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
      out[at] = Math.round(byAlpha && a > 0 ? r / a : plain[0]! / 4);
      out[at + 1] = Math.round(byAlpha && a > 0 ? g / a : plain[1]! / 4);
      out[at + 2] = Math.round(byAlpha && a > 0 ? b / a : plain[2]! / 4);
      out[at + 3] = Math.round(a / 4);
    }
  }
  return out;
}
