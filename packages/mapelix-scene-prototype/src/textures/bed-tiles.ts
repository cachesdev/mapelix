import type { PackImage } from "./pack-image.js";

/** Bed colors by the block entity's `color` byte, as `entity/bed/<color>.png` names them. */
export const BED_COLORS = [
  "white",
  "orange",
  "magenta",
  "light_blue",
  "yellow",
  "lime",
  "pink",
  "gray",
  "silver",
  "cyan",
  "purple",
  "blue",
  "brown",
  "green",
  "red",
  "black",
] as const;

/**
 * Block tiles cut from a bed's entity texture: the mattress top of each half, with the head
 * half's row 0 at the headboard, and the sides and ends of the mattress in rows 7 to 12, where
 * a block side shows heights 9 down to 3.
 */
export const BED_TILES = [
  "head_top",
  "foot_top",
  "head_side",
  "foot_side",
  "head_end",
  "foot_end",
] as const;
export type BedTile = (typeof BED_TILES)[number];

export const bedTexturePath = (color: string): string => `textures/entity/bed/${color}`;
export const bedTilePath = (color: string, tile: BedTile): string =>
  `${bedTexturePath(color)}#${tile}`;

/**
 * Cuts one block tile from a bed entity texture laid out on 64 by 64 texels, as the game's
 * bed is: the 16 by 32 mattress top from (6, 6), its long sides from (0, 6) and (22, 6), six
 * texels thick with the wood at the outer edge, and its ends from (6, 0) and (22, 0). Larger
 * textures keep their own detail. Returns undefined for an image of another shape.
 */
export function cutBedTile(image: PackImage, tile: BedTile): PackImage | undefined {
  const scale = image.width / 64;
  if (!Number.isInteger(scale) || scale < 1 || image.height !== image.width) return undefined;
  const side = 16 * scale;
  const rgba = new Uint8Array(side * side * 4);
  const head = tile.startsWith("head");
  for (let py = 0; py < side; py++)
    for (let px = 0; px < side; px++) {
      const u = Math.floor(px / scale);
      const v = Math.floor(py / scale);
      const fu = px - u * scale;
      const fv = py - v * scale;
      // Sides and ends hold six texels of height in rows 7 to 12; the rows past them repeat.
      const height = Math.min(12, Math.max(7, v));
      let x: number;
      let y: number;
      if (tile.endsWith("top")) {
        x = (6 + u) * scale + fu;
        y = ((head ? 6 : 22) + v) * scale + fv;
      } else if (tile.endsWith("side")) {
        x = (12 - height) * scale + (scale - 1 - fv);
        y = ((head ? 6 : 22) + u) * scale + fu;
      } else {
        x = ((head ? 6 : 22) + u) * scale + fu;
        y = (12 - height) * scale + (scale - 1 - fv);
      }
      rgba.set(
        image.rgba.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4),
        (py * side + px) * 4,
      );
    }
  return { width: side, height: side, rgba };
}
