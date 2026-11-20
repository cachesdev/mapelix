import {
  DIMENSIONS,
  contextKey,
  sceneContext,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";
import type { VerticalMovement } from "./camera-rig";

/** A single adjacent slice; never expands thickness or changes cache identity rules. */
export function adjacentDepth(
  context: SceneContext,
  y: number,
  direction: VerticalMovement,
): SceneContext | undefined {
  if (context.mode !== "caves" || !direction || !Number.isFinite(y)) return;
  const thickness = context.maxY - context.minY;
  const margin = thickness === 32 ? 4 : 0;
  if (direction > 0 ? y < context.maxY - 1 - margin : y > context.minY + margin) return;
  const limits = DIMENSIONS[context.dimension];
  const minY = Math.max(
    limits.minY,
    Math.min(context.minY + direction * 16, limits.maxY - thickness),
  );
  if (minY === context.minY) return;
  return sceneContext(context.dimension, { mode: "caves", minY, maxY: minY + thickness });
}

export interface DepthNavigation {
  readonly available: boolean;
  readonly autoDepth: boolean;
  readonly loading: boolean;
  readonly error: string | undefined;
}

/** Metadata is supplied by the host, so embedded viewers retain their URL/auth contract. */
export class DepthFollow<T extends SceneContextInput> {
  private enabled: boolean;
  private pending: AbortController | undefined;
  private candidate: string | undefined;
  private candidateSince = 0;
  private nextStart = 0;
  private error: string | undefined;

  constructor(
    private readonly load: ((context: SceneContext, signal: AbortSignal) => Promise<T>) | undefined,
    private readonly apply: (world: T) => void,
    enabled = false,
    private readonly intervalMs = 2000,
  ) {
    if (!Number.isFinite(intervalMs) || intervalMs < 1000)
      throw new RangeError("Automatic depth interval must be at least 1000 ms");
    this.enabled = enabled;
  }

  get state(): DepthNavigation {
    return {
      available: this.load !== undefined,
      autoDepth: this.enabled && this.load !== undefined,
      loading: this.pending !== undefined,
      error: this.error,
    };
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  /** Manual context changes, recovery and disposal invalidate even late responses. */
  cancel(): void {
    this.pending?.abort();
    this.pending = undefined;
    this.candidate = undefined;
    this.error = undefined;
  }

  update(
    context: SceneContext,
    y: number,
    direction: VerticalMovement,
    ready: boolean,
    now: number,
  ): void {
    if (!this.enabled || !this.load || this.pending) return;
    const next = adjacentDepth(context, y, direction);
    if (!next || !ready) {
      this.candidate = undefined;
      return;
    }
    const key = contextKey(next);
    if (key !== this.candidate) {
      this.candidate = key;
      this.candidateSince = now;
    }
    // Debounce held intent and wait for terrain before visiting another depth.
    if (now < this.nextStart || now - this.candidateSince < 250) return;
    this.nextStart = now + this.intervalMs;
    const controller = new AbortController();
    this.pending = controller;
    this.error = undefined;
    let loaded: Promise<T>;
    try {
      loaded = this.load(next, controller.signal);
    } catch (cause) {
      loaded = Promise.reject(cause);
    }
    void loaded
      .then((world) => {
        if (this.pending !== controller || controller.signal.aborted) return;
        if (contextKey(world) !== key)
          throw new Error("The server returned a different cave slice");
        this.apply(world);
      })
      .catch((cause: unknown) => {
        if (this.pending !== controller || controller.signal.aborted) return;
        this.error = cause instanceof Error ? cause.message : String(cause);
        this.nextStart = Math.max(this.nextStart, now + 5000);
      })
      .finally(() => {
        if (this.pending === controller) {
          this.pending = undefined;
          this.candidate = undefined;
        }
      });
  }
}
