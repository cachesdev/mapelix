/** Tile edge in image pixels; tile `x`/`y` at zoom `z` cover `256 / 2^z` blocks east/south. */
export const TILE_SIZE = 256;

/** What the 2D map shows: the block at the center of the element and the scale. */
export interface MapView {
  /** Block X (east) at the center of the element. */
  readonly x: number;
  /** Block Z (south) at the center of the element. */
  readonly z: number;
  /** CSS pixels per block; the 2D map zoom `z` draws `2^z`. */
  readonly pixelsPerBlock: number;
}

export interface TileAddress {
  readonly z: number;
  readonly x: number;
  readonly y: number;
}

/** A rectangle in device pixels. */
export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Blocks covered by one tile edge at `zoom`. */
export function tileSpan(zoom: number): number {
  return TILE_SIZE / 2 ** zoom;
}

/**
 * The tile zoom to draw: the coarsest available one whose pixels are not larger than device
 * pixels, so tiles are only ever shrunk (smooth) or, beyond the finest zoom, enlarged with
 * nearest-neighbour sampling (sharp). `zooms` must be sorted ascending.
 */
export function levelFor(
  pixelsPerBlock: number,
  devicePixelRatio: number,
  zooms: readonly number[],
): number {
  const device = pixelsPerBlock * devicePixelRatio;
  for (const zoom of zooms) if (2 ** zoom >= device * (1 - 1e-9)) return zoom;
  return zooms[zooms.length - 1]!;
}

/** Block bounds of the element: `[west, north, east, south]`. */
export function viewBounds(
  view: MapView,
  width: number,
  height: number,
): readonly [number, number, number, number] {
  const halfWidth = width / 2 / view.pixelsPerBlock,
    halfHeight = height / 2 / view.pixelsPerBlock;
  return [view.x - halfWidth, view.z - halfHeight, view.x + halfWidth, view.z + halfHeight];
}

/**
 * Tiles at `zoom` that touch the element, plus `margin` tiles around it, nearest to the center
 * first so the middle of the screen fills in before the edges.
 */
export function visibleTiles(
  view: MapView,
  width: number,
  height: number,
  zoom: number,
  margin = 0,
): TileAddress[] {
  const span = tileSpan(zoom);
  const [west, north, east, south] = viewBounds(view, width, height);
  const x0 = Math.floor(west / span) - margin,
    x1 = Math.ceil(east / span) - 1 + margin,
    y0 = Math.floor(north / span) - margin,
    y1 = Math.ceil(south / span) - 1 + margin;
  const tiles: TileAddress[] = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) tiles.push({ z: zoom, x, y });
  const cx = view.x / span - 0.5,
    cy = view.z / span - 0.5;
  return tiles.sort(
    (a, b) => (a.x - cx) ** 2 + (a.y - cy) ** 2 - ((b.x - cx) ** 2 + (b.y - cy) ** 2),
  );
}

/**
 * Where a block-space rectangle lands on the canvas, rounded to whole device pixels. Each edge
 * is rounded on its own, so neighbouring tiles share their edge exactly: no gap, no overlap.
 */
export function blockRectToPixels(
  view: MapView,
  canvasWidth: number,
  canvasHeight: number,
  devicePixelRatio: number,
  west: number,
  north: number,
  east: number,
  south: number,
): PixelRect {
  const scale = view.pixelsPerBlock * devicePixelRatio;
  const ox = canvasWidth / 2 - view.x * scale,
    oy = canvasHeight / 2 - view.z * scale;
  return {
    left: Math.round(ox + west * scale),
    top: Math.round(oy + north * scale),
    right: Math.round(ox + east * scale),
    bottom: Math.round(oy + south * scale),
  };
}

export function tileRect(
  view: MapView,
  canvasWidth: number,
  canvasHeight: number,
  devicePixelRatio: number,
  tile: TileAddress,
): PixelRect {
  const span = tileSpan(tile.z);
  return blockRectToPixels(
    view,
    canvasWidth,
    canvasHeight,
    devicePixelRatio,
    tile.x * span,
    tile.y * span,
    (tile.x + 1) * span,
    (tile.y + 1) * span,
  );
}

/** The block under a point given in CSS pixels from the element's top-left corner. */
export function blockAt(
  view: MapView,
  width: number,
  height: number,
  px: number,
  py: number,
): { x: number; z: number } {
  return {
    x: view.x + (px - width / 2) / view.pixelsPerBlock,
    z: view.z + (py - height / 2) / view.pixelsPerBlock,
  };
}

/** Changes the scale while the block under `(px, py)` stays under it. */
export function zoomAround(
  view: MapView,
  pixelsPerBlock: number,
  width: number,
  height: number,
  px: number,
  py: number,
): MapView {
  const anchor = blockAt(view, width, height, px, py);
  return {
    x: anchor.x - (px - width / 2) / pixelsPerBlock,
    z: anchor.z - (py - height / 2) / pixelsPerBlock,
    pixelsPerBlock,
  };
}

/** Moves the map with the pointer: content follows a drag of `(dx, dy)` CSS pixels. */
export function panBy(view: MapView, dx: number, dy: number): MapView {
  return {
    x: view.x - dx / view.pixelsPerBlock,
    z: view.z - dy / view.pixelsPerBlock,
    pixelsPerBlock: view.pixelsPerBlock,
  };
}

/**
 * Two-finger gesture: the blocks first under the two fingers stay under them. `start` and
 * `now` are the finger midpoints and distances in CSS pixels.
 */
export function pinch(
  view: MapView,
  width: number,
  height: number,
  start: { readonly x: number; readonly y: number; readonly distance: number },
  now: { readonly x: number; readonly y: number; readonly distance: number },
  clamp: (pixelsPerBlock: number) => number,
): MapView {
  const anchor = blockAt(view, width, height, start.x, start.y);
  const pixelsPerBlock = clamp((view.pixelsPerBlock * now.distance) / Math.max(start.distance, 1));
  return {
    x: anchor.x - (now.x - width / 2) / pixelsPerBlock,
    z: anchor.z - (now.y - height / 2) / pixelsPerBlock,
    pixelsPerBlock,
  };
}

/** The ancestor at `zoom` (≤ tile.z) and the part of it, in its own image pixels, covering `tile`. */
export function ancestorSource(
  tile: TileAddress,
  zoom: number,
): { readonly tile: TileAddress; readonly sx: number; readonly sy: number; readonly size: number } {
  const factor = 2 ** (tile.z - zoom);
  const x = Math.floor(tile.x / factor),
    y = Math.floor(tile.y / factor);
  const size = TILE_SIZE / factor;
  return {
    tile: { z: zoom, x, y },
    sx: (tile.x - x * factor) * size,
    sy: (tile.y - y * factor) * size,
    size,
  };
}
