/** Bounds in sixteenths: low xyz, high xyz, each from 0 to 16. */
export type ModelBounds = readonly [number, number, number, number, number, number];

/** Packs bounds into 30 bits, five per coordinate, low x in the lowest bits. */
export function packModelBounds(bounds: ModelBounds): number {
  let code = 0;
  for (const [index, coordinate] of bounds.entries()) {
    if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 16)
      throw new RangeError("Invalid model bounds: " + bounds.join(","));
    code |= coordinate << (index * 5);
  }
  return code >>> 0;
}

export function unpackModelBounds(code: number): ModelBounds {
  return [
    code & 31,
    (code >>> 5) & 31,
    (code >>> 10) & 31,
    (code >>> 15) & 31,
    (code >>> 20) & 31,
    (code >>> 25) & 31,
  ];
}
