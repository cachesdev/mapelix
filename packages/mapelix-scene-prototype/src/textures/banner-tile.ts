import type { PackImage } from "./pack-image.js";

export const BANNER_TEXTURE = "textures/entity/banner/banner";
export const BANNER_TILE = `${BANNER_TEXTURE}#cloth`;

/** Native Bedrock sheets pack 64-square pattern cells in a 512-square image. */
export function bannerTileSide(width: number, height: number): number | undefined {
  const scale = width / (width >= 512 ? 512 : 64);
  return width === height && Number.isInteger(scale) && scale >= 1 ? 16 * scale : undefined;
}

/**
 * The entity sheet's cloth front occupies (1, 1)..(21, 41) in its first pattern cell.
 * Standalone 64-square sheets and enlarged native sheets use the same relative UVs.
 * Fit it to the existing 14-square model face, in tile columns 1..14, rows 0..13.
 * Edge padding repeats cloth texels, never the sheet's wooden pole or empty space.
 */
export function cutBannerTile(image: PackImage): PackImage | undefined {
  const side = bannerTileSide(image.width, image.height);
  if (side === undefined) return undefined;
  const scale = side / 16;
  const rgba = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const u = Math.max(0, Math.min(14 * scale - 1, x - scale));
      const v = Math.min(14 * scale - 1, y);
      const sx = scale + Math.floor((u * 20) / 14);
      const sy = scale + Math.floor((v * 40) / 14);
      const offset = (sy * image.width + sx) * 4;
      rgba.set(image.rgba.subarray(offset, offset + 4), (y * side + x) * 4);
    }
  return { width: side, height: side, rgba };
}
