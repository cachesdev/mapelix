/** Client-side clipping only: selections never change reusable terrain/cache identities. */
export interface HorizontalSelection {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export const SELECTION_LIMITS = { minSize: 16, maxSize: 256, defaultSize: 64 } as const;
const names = ["minX", "maxX", "minZ", "maxZ"] as const;
// Bedrock chunk keys are signed 32-bit; keep block coordinates in Minecraft's useful range.
export const MAX_BLOCK_COORDINATE = 30_000_000;

export function horizontalSelection(input: HorizontalSelection): HorizontalSelection {
  if (
    names.some(
      (name) => !Number.isSafeInteger(input[name]) || Math.abs(input[name]) > MAX_BLOCK_COORDINATE,
    )
  )
    throw new RangeError("Selection coordinates must be integers within world bounds");
  for (const size of [input.maxX - input.minX, input.maxZ - input.minZ]) {
    if (size < SELECTION_LIMITS.minSize || size > SELECTION_LIMITS.maxSize)
      throw new RangeError("Selection sides must be between 16 and 256 blocks");
  }
  return { minX: input.minX, maxX: input.maxX, minZ: input.minZ, maxZ: input.maxZ };
}

export function selectionFromSearch(params: URLSearchParams): HorizontalSelection | undefined {
  if (!names.some((name) => params.has(name))) return undefined;
  const values = names.map((name) => {
    const raw = params.get(name);
    return raw === null || raw.trim() === "" ? NaN : Number(raw);
  });
  return horizontalSelection({
    minX: values[0]!,
    maxX: values[1]!,
    minZ: values[2]!,
    maxZ: values[3]!,
  });
}

export function selectionAround(
  x: number,
  z: number,
  size: number = SELECTION_LIMITS.defaultSize,
): HorizontalSelection {
  const minX = Math.floor(x - size / 2),
    minZ = Math.floor(z - size / 2);
  return horizontalSelection({ minX, minZ, maxX: minX + size, maxZ: minZ + size });
}

export function selectionContains(selection: HorizontalSelection, x: number, z: number): boolean {
  return x >= selection.minX && x < selection.maxX && z >= selection.minZ && z < selection.maxZ;
}

export function selectionIntersects(
  selection: HorizontalSelection,
  x: number,
  z: number,
  span: number,
): boolean {
  return (
    x < selection.maxX &&
    x + span > selection.minX &&
    z < selection.maxZ &&
    z + span > selection.minZ
  );
}

/** Distance interval inside the selected X/Z rectangle, shared by picking and camera collision. */
export function selectedRayRange(
  selection: HorizontalSelection,
  origin: { x: number; z: number },
  direction: { x: number; z: number },
  far: number,
): readonly [number, number] | undefined {
  let near = 0,
    end = far;
  for (const axis of ["x", "z"] as const) {
    const min = axis === "x" ? selection.minX : selection.minZ;
    const max = axis === "x" ? selection.maxX : selection.maxZ;
    const delta = direction[axis];
    if (Math.abs(delta) < 1e-10) {
      if (origin[axis] < min || origin[axis] >= max) return undefined;
    } else {
      const a = (min - origin[axis]) / delta,
        b = (max - origin[axis]) / delta;
      near = Math.max(near, Math.min(a, b));
      end = Math.min(end, Math.max(a, b));
      if (near >= end) return undefined;
    }
  }
  return [near, end];
}
