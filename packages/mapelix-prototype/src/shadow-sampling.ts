export type ShadowPixelSampler = (x: number, z: number) => boolean;

/** Runs uNmINeD's models-off corner/edge/interior shadow sampling schedule. */
export function sampleShadowPixels(size: number, sample: ShadowPixelSampler): void {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError(`Shadow sample size must be a positive integer, received ${size}`);
  }
  if (size <= 2) {
    for (let x = 0; x < size; x += 1) {
      for (let z = 0; z < size; z += 1) sample(x, z);
    }
    return;
  }

  const last = size - 1;
  const topLeft = sample(0, 0);
  const topRight = sample(last, 0);
  const bottomLeft = sample(0, last);
  const bottomRight = sample(last, last);
  if (!(topLeft || topRight || bottomLeft || bottomRight)) return;

  const hitColumns = new Uint8Array(size);
  const hitRows = new Uint8Array(size);
  const sampleTop = topLeft || topRight;
  const sampleBottom = bottomLeft || bottomRight;
  const sampleLeft = topLeft || bottomLeft;
  const sampleRight = topRight || bottomRight;

  for (let x = 1; x < last; x += 1) {
    const top = sampleTop && sample(x, 0);
    const bottom = sampleBottom && sample(x, last);
    if (top || bottom) hitColumns[x] = 1;
  }
  for (let z = 1; z < last; z += 1) {
    const left = sampleLeft && sample(0, z);
    const right = sampleRight && sample(last, z);
    if (left || right) hitRows[z] = 1;
  }
  for (let x = 1; x < last; x += 1) {
    if (hitColumns[x] !== 1) continue;
    for (let z = 1; z < last; z += 1) {
      if (hitRows[z] === 1) sample(x, z);
    }
  }
}
