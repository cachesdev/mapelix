/** Pointer speed, in CSS pixels per millisecond, from the last 100 ms of movement. */
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  reset(t: number, x: number, y: number): void {
    this.samples = [{ t, x, y }];
  }

  add(t: number, x: number, y: number): void {
    this.samples.push({ t, x, y });
    while (this.samples.length > 2 && t - this.samples[0]!.t > 100) this.samples.shift();
  }

  /** Zero when the pointer rested for more than 50 ms before release. */
  velocity(now: number): { x: number; y: number } {
    const first = this.samples[0],
      last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined || last === first || now - last.t > 50)
      return { x: 0, y: 0 };
    const dt = Math.max(last.t - first.t, 1);
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}

/** Time constant of the glide after a fling, as on common touch platforms. */
export const INERTIA_MS = 325;
/** Slower flings than this (px/ms) stop at once. */
export const INERTIA_MIN_SPEED = 0.05;

/**
 * Glide after a fling: speed decays exponentially. Returns the distance travelled during `dt`
 * and the remaining speed.
 */
export function glide(
  velocity: { readonly x: number; readonly y: number },
  dt: number,
): { dx: number; dy: number; velocity: { x: number; y: number } } {
  const decay = Math.exp(-dt / INERTIA_MS);
  const travel = INERTIA_MS * (1 - decay);
  return {
    dx: velocity.x * travel,
    dy: velocity.y * travel,
    velocity: { x: velocity.x * decay, y: velocity.y * decay },
  };
}

/** Zoom factor for one wheel event: one mouse notch (100 px) zooms by about √2. */
export function wheelFactor(deltaY: number, deltaMode: number, pinchGesture: boolean): number {
  const pixels = deltaMode === 1 ? deltaY * 40 : deltaMode === 2 ? deltaY * 800 : deltaY;
  // Trackpad pinches arrive as small ctrl+wheel deltas and need a stronger response.
  const clamped = Math.max(-300, Math.min(300, pixels * (pinchGesture ? 4 : 1)));
  return 2 ** (-clamped / 200);
}

/** Recognises a quick second tap close to the first one. */
export class TapDetector {
  private last: { t: number; x: number; y: number } | undefined;

  constructor(
    private readonly maxTapMs = 250,
    private readonly maxGapMs = 300,
    private readonly maxDistance = 30,
  ) {}

  /** Call on release of a single pointer; returns true for the second tap of a pair. */
  release(downAt: number, upAt: number, moved: number, x: number, y: number): boolean {
    if (upAt - downAt > this.maxTapMs || moved > 10) {
      this.last = undefined;
      return false;
    }
    const previous = this.last;
    if (
      previous !== undefined &&
      downAt - previous.t <= this.maxGapMs &&
      Math.hypot(x - previous.x, y - previous.y) <= this.maxDistance
    ) {
      this.last = undefined;
      return true;
    }
    this.last = { t: upAt, x, y };
    return false;
  }
}

/** Ease-out cubic, for animated zooms and key moves. */
export function easeOut(t: number): number {
  const u = 1 - Math.min(Math.max(t, 0), 1);
  return 1 - u * u * u;
}
