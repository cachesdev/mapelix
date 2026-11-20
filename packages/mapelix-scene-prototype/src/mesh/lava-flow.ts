/** Zero is convection; 1..8 are east, southeast, south, southwest, west, northwest, north, northeast. */
export function lavaFlowDirection(
  east: number,
  west: number,
  south: number,
  north: number,
): number {
  const x = west - east;
  const z = north - south;
  if (x === 0 && z === 0) return 0;
  return ((Math.round((Math.atan2(z, x) * 4) / Math.PI) + 8) & 7) + 1;
}
