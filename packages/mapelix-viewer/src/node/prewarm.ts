import type { Dimension, RegionRequest } from "@mapelix/scene-prototype";
import { MAX_REGION_LEVEL, regionSpan } from "@mapelix/scene-prototype/format";

import type { BlockBounds } from "./bounds.js";
import { OverloadedError, isAbort, type RegionResult } from "./region-service.js";

export interface PrewarmJob extends RegionRequest {
  readonly dimension: Dimension;
}

export interface PrewarmProgress {
  readonly state: "idle" | "running" | "done" | "stopped";
  readonly done: number;
  readonly total: number;
  readonly built: number;
  readonly failed: number;
  readonly reason?: string;
}

export interface PrewarmTarget {
  load(
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
    options: { readonly background: true },
  ): Promise<RegionResult>;
}

/**
 * Every region that touches the stored area, one dimension after the other in the
 * order given, coarse levels first and, within a level, nearest the middle of the
 * world first. A capped plan keeps the first dimension's coarse levels. Jobs carry
 * no ceiling: each dimension's default one is what visitors ask for first.
 */
export function prewarmPlan(
  dimensions: ReadonlyMap<Dimension, BlockBounds | undefined>,
  maxRegions: number,
): PrewarmJob[] {
  const jobs: PrewarmJob[] = [];
  // Dimension by dimension, so only one dimension's builders are busy at a time.
  for (const [dimension, bounds] of dimensions) {
    if (bounds === undefined) continue;
    for (let level = MAX_REGION_LEVEL; level >= 0; level -= 1) {
      const span = regionSpan(level);
      const centerX = (bounds.minX + bounds.maxX) / 2 / span;
      const centerZ = (bounds.minZ + bounds.maxZ) / 2 / span;
      const levelJobs: (PrewarmJob & { distance: number })[] = [];
      for (let x = Math.floor(bounds.minX / span); x <= Math.floor(bounds.maxX / span); x += 1) {
        for (let z = Math.floor(bounds.minZ / span); z <= Math.floor(bounds.maxZ / span); z += 1) {
          levelJobs.push({
            dimension,
            level,
            x,
            z,
            distance: (x - centerX) ** 2 + (z - centerZ) ** 2,
          });
        }
      }
      levelJobs.sort((left, right) => left.distance - right.distance);
      for (const { distance: _distance, ...job } of levelJobs) {
        if (jobs.length >= maxRegions) return jobs;
        jobs.push(job);
      }
    }
  }
  return jobs;
}

/**
 * Builds the plan one region at a time through the normal cache, so a visitor's
 * request waits behind at most one prewarm build. Regions already on disk are
 * only read. It stops when the disk cache is nearly full rather than evicting
 * what it has just built.
 */
export class Prewarmer {
  private readonly target: PrewarmTarget;
  private readonly jobs: readonly PrewarmJob[];
  private readonly cacheNearlyFull: () => boolean;
  private readonly onEvent: ((event: string, detail: Record<string, unknown>) => void) | undefined;
  private current: PrewarmProgress;

  constructor(
    target: PrewarmTarget,
    jobs: readonly PrewarmJob[],
    cacheNearlyFull: () => boolean,
    onEvent?: (event: string, detail: Record<string, unknown>) => void,
  ) {
    this.target = target;
    this.jobs = jobs;
    this.cacheNearlyFull = cacheNearlyFull;
    this.onEvent = onEvent;
    this.current = { state: "idle", done: 0, total: jobs.length, built: 0, failed: 0 };
  }

  get progress(): PrewarmProgress {
    return this.current;
  }

  async run(signal: AbortSignal, retryDelay = 1000): Promise<PrewarmProgress> {
    const startedAt = performance.now();
    this.current = { ...this.current, state: "running" };
    this.onEvent?.("prewarm.started", { regions: this.jobs.length });
    let index = 0;
    while (index < this.jobs.length) {
      if (signal.aborted) return this.stop("shutdown");
      if (this.cacheNearlyFull()) return this.stop("cache-full");
      const { dimension, ...request } = this.jobs[index]!;
      try {
        // Background: a visitor waiting for a builder always goes first.
        const result = await this.target.load(dimension, request, signal, { background: true });
        this.current = {
          ...this.current,
          done: this.current.done + 1,
          built: this.current.built + (result.cacheStatus === "build" ? 1 : 0),
        };
        index += 1;
      } catch (cause) {
        if (isAbort(cause)) return this.stop("shutdown");
        if (cause instanceof OverloadedError) {
          // Visitors come first: wait for the queue to drain, then retry this region.
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          continue;
        }
        this.current = {
          ...this.current,
          done: this.current.done + 1,
          failed: this.current.failed + 1,
        };
        index += 1;
      }
    }
    this.current = { ...this.current, state: "done" };
    this.onEvent?.("prewarm.done", {
      ...this.current,
      seconds: Math.round((performance.now() - startedAt) / 100) / 10,
    });
    return this.current;
  }

  private stop(reason: string): PrewarmProgress {
    this.current = { ...this.current, state: "stopped", reason };
    this.onEvent?.("prewarm.stopped", { ...this.current });
    return this.current;
  }
}
