/** Water captures the preceding framebuffer: cosmetic overlays must follow it. */
export const RENDER_ORDER = {
  terrain: 0,
  plants: 1,
  water: 2,
  glass: 3,
  clouds: 4,
  rain: 5,
} as const;
