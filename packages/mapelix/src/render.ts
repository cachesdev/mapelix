import { defaultBlockStyle, type BlockStyleResolver, type RgbaColor } from "./block-style.js";
import { TILE_SIZE, type SurfaceSamples } from "./tile.js";

export interface RenderSurfaceOptions {
  readonly resolveBlockStyle?: BlockStyleResolver;
}

export function renderSurface(
  samples: SurfaceSamples,
  options: RenderSurfaceOptions = {},
): Uint8Array {
  if (samples.length !== TILE_SIZE * TILE_SIZE) {
    throw new RangeError(
      `Expected ${TILE_SIZE * TILE_SIZE} surface samples, got ${samples.length}`,
    );
  }

  const resolveBlockStyle = options.resolveBlockStyle ?? defaultBlockStyle;
  const rgba = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);

  for (let z = 0; z < TILE_SIZE; z += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const index = z * TILE_SIZE + x;
      const sample = samples[index];
      if (sample === undefined) {
        continue;
      }

      const base = resolveBlockStyle(sample.name);
      const shade = calculateShade(samples, x, z, sample.y);
      writeColor(rgba, index * 4, base, shade);
    }
  }
  return rgba;
}

function calculateShade(samples: SurfaceSamples, x: number, z: number, height: number): number {
  const northHeight = z > 0 ? samples[(z - 1) * TILE_SIZE + x]?.y : undefined;
  const westHeight = x > 0 ? samples[z * TILE_SIZE + x - 1]?.y : undefined;
  const northDelta = northHeight === undefined ? 0 : height - northHeight;
  const westDelta = westHeight === undefined ? 0 : height - westHeight;
  return clamp(1 + northDelta * 0.035 + westDelta * 0.025, 0.72, 1.22);
}

function writeColor(target: Uint8Array, offset: number, base: RgbaColor, shade: number): void {
  target[offset] = Math.round(clamp(base.red * shade, 0, 255));
  target[offset + 1] = Math.round(clamp(base.green * shade, 0, 255));
  target[offset + 2] = Math.round(clamp(base.blue * shade, 0, 255));
  target[offset + 3] = base.alpha;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
