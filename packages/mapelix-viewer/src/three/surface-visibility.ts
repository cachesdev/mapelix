const SIDES = [
  [1, 0, 0, 1],
  [-1, 0, 0, -1],
  [0, 1, 2, 1],
  [0, -1, 2, -1],
] as const;

/** Exact exterior evidence only: no coarse heights, depth margin, or guessed air. */
export function exteriorBlock(
  x: number,
  y: number,
  z: number,
  heightAt: (x: number, z: number) => number | undefined,
  sideFace: (x: number, y: number, z: number, axis: number, sign: number) => boolean,
): boolean {
  const top = heightAt(x, z);
  if (top === undefined || top < y + 1) return false;
  if (top === y + 1) return true;
  for (const [dx, dz, axis, sign] of SIDES) {
    const neighbor = heightAt(x + dx, z + dz);
    if (neighbor !== undefined && neighbor <= y + 1 && sideFace(x, y, z, axis, sign)) return true;
  }
  return false;
}
