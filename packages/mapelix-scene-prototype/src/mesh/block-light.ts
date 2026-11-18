interface LightVolume {
  readonly width: number;
  readonly layers: number;
  readonly emission: (index: number) => number;
  readonly opaque: (index: number) => boolean;
  /** Source window includes 15 blocks beyond every potentially visible face. */
  readonly minLayer?: number;
  readonly maxLayer?: number;
}

/** A typed queue per light level; no per-cell objects and no Array.shift(). */
class LightQueue {
  cells = new Uint32Array(256);
  count = 0;

  push(index: number): void {
    if (this.count === this.cells.length) {
      const grown = new Uint32Array(this.cells.length * 2);
      grown.set(this.cells);
      this.cells = grown;
    }
    this.cells[this.count++] = index;
  }
}

/**
 * Six-neighbor block light with unit attenuation. Brightest sources run first, so a
 * propagated value is final. Opaque sources still light their neighbors. The caller supplies
 * a full 16-block source margin; clipping mesh geometry never clips the light volume.
 */
export function buildBlockLight(volume: LightVolume): Uint8Array | undefined {
  const { width, layers, emission, opaque } = volume;
  const area = width * width;
  const count = area * layers;
  const first = Math.max(0, volume.minLayer ?? 0) * area;
  const last = Math.min(layers, volume.maxLayer ?? layers) * area;
  let light: Uint8Array | undefined;
  const queues = Array.from({ length: 16 }, () => new LightQueue());
  for (let index = first; index < last; index++) {
    const level = emission(index);
    if (level === 0) continue;
    light ??= new Uint8Array(count);
    light[index] = level;
    queues[level]!.push(index);
  }
  if (light === undefined) return undefined;
  for (let level = 15; level > 1; level--) {
    const queue = queues[level]!;
    const next = level - 1;
    const visit = (index: number) => {
      if (light[index]! >= next || opaque(index)) return;
      light[index] = next;
      queues[next]!.push(index);
    };
    for (let head = 0; head < queue.count; head++) {
      const index = queue.cells[head]!;
      if (light[index] !== level) continue;
      const column = index % area;
      const x = column % width;
      const z = Math.floor(column / width);
      if (x > 0) visit(index - 1);
      if (x + 1 < width) visit(index + 1);
      if (z > 0) visit(index - width);
      if (z + 1 < width) visit(index + width);
      if (index - area >= first) visit(index - area);
      if (index + area < last) visit(index + area);
    }
  }
  return light;
}
