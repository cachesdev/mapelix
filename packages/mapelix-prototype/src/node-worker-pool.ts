import { Worker } from "node:worker_threads";

import type { StoredSurfaceEntry } from "./chunk-surface-store.js";
import type { IndexedTileRenderJob } from "./node-tile-render.js";
import { tileBounds, type RenderedTile } from "./tile.js";
import { renderAbortError } from "./render-abort.js";
import type { CloseWorldOptions } from "./world.js";

interface WorkerResponse {
  readonly id: number;
  readonly tile?: RenderedTile;
  readonly error?: string;
  readonly surfaces?: readonly StoredSurfaceEntry[];
  readonly surfaceStats?: SurfaceReport["stats"];
}

/** Surfaces a worker extracted for the disk store, and its store counters, for one tile. */
export interface SurfaceReport {
  readonly surfaces: readonly StoredSurfaceEntry[];
  readonly stats: { readonly hits: number; readonly stored: number; readonly rejected: number };
}

interface PendingRender {
  readonly id: number;
  readonly job: IndexedTileRenderJob;
  readonly resolve: (tile: RenderedTile) => void;
  readonly reject: (cause: Error) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  active: PendingRender | undefined;
  /** Block-space centre of the last job, used to keep neighbouring tiles on one warm cache. */
  last: JobLocation | undefined;
}

interface JobLocation {
  readonly dimension: string;
  readonly x: number;
  readonly z: number;
}

export class TileRenderWorkerPool {
  readonly concurrency: number;
  private readonly renderCacheMiB: number | undefined;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingRender[] = [];
  private readonly pending = new Set<Promise<RenderedTile>>();
  private nextId = 1;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly onSurfaces: ((report: SurfaceReport) => void) | undefined;

  constructor(
    concurrency: number,
    renderCacheMiB?: number,
    onSurfaces?: (report: SurfaceReport) => void,
  ) {
    this.concurrency = concurrency;
    this.renderCacheMiB = renderCacheMiB;
    this.onSurfaces = onSurfaces;
    for (let index = 0; index < concurrency; index += 1) {
      this.slots.push(this.createSlot());
    }
  }

  render(job: IndexedTileRenderJob): Promise<RenderedTile> {
    if (this.closed) return Promise.reject(new Error("The tile worker pool is closed"));
    const promise = new Promise<RenderedTile>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject });
      this.dispatch();
    });
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }

  close(options: CloseWorldOptions = {}): Promise<void> {
    this.closed = true;
    if (options.abort === true) {
      const cause = renderAbortError();
      for (const pending of this.queue.splice(0)) pending.reject(cause);
      for (const slot of this.slots) {
        slot.active?.reject(cause);
        slot.active = undefined;
      }
    }
    this.closePromise ??= this.drainAndClose();
    return this.closePromise;
  }

  private async drainAndClose(): Promise<void> {
    await Promise.allSettled(this.pending);
    const slots = this.slots.splice(0);
    await Promise.all(slots.map((slot) => slot.worker.terminate()));
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(new URL("./node-render-worker.js", import.meta.url), {
      workerData: { renderCacheMiB: this.renderCacheMiB },
    });
    const slot: WorkerSlot = { worker, active: undefined, last: undefined };
    worker.on("message", (response: WorkerResponse) => this.complete(slot, response));
    worker.on("error", (cause) => this.fail(slot, cause));
    worker.on("exit", (code) => {
      this.fail(slot, new Error(`Mapelix render worker exited with code ${code}`));
    });
    // Adding a message listener refs the port; only idle workers may be unreferenced.
    worker.unref();
    return slot;
  }

  private dispatch(): void {
    while (this.queue.length > 0) {
      const location = jobLocation(this.queue[0]!.job);
      const slot = nearestIdleSlot(this.slots, location);
      if (slot === undefined) return;
      const pending = this.queue.shift()!;
      slot.active = pending;
      slot.last = location;
      slot.worker.ref();
      try {
        slot.worker.postMessage({ id: pending.id, job: pending.job });
      } catch (cause) {
        slot.active = undefined;
        slot.worker.unref();
        pending.reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    }
  }

  private complete(slot: WorkerSlot, response: WorkerResponse): void {
    const pending = slot.active;
    if (pending === undefined || pending.id !== response.id) {
      return;
    }
    slot.active = undefined;
    slot.worker.unref();
    if (response.tile !== undefined) {
      if (response.surfaces !== undefined && response.surfaceStats !== undefined)
        this.onSurfaces?.({ surfaces: response.surfaces, stats: response.surfaceStats });
      pending.resolve(response.tile);
    } else {
      pending.reject(new Error(response.error ?? "Mapelix render worker returned no tile"));
    }
    this.dispatch();
  }

  private fail(slot: WorkerSlot, cause: Error): void {
    const slotIndex = this.slots.indexOf(slot);
    if (slotIndex < 0) {
      return;
    }
    this.slots.splice(slotIndex, 1);
    slot.active?.reject(cause);
    slot.worker.unref();
    if (!this.closed || this.queue.length > 0) this.slots.push(this.createSlot());
    this.dispatch();
  }
}

function jobLocation(job: IndexedTileRenderJob): JobLocation {
  const bounds = tileBounds(job.coordinates);
  return {
    dimension: job.coordinates.dimension,
    x: (bounds.minX + bounds.maxX) / 2,
    z: (bounds.minZ + bounds.maxZ) / 2,
  };
}

/** Prefers the idle worker whose previous tile was nearest, so its caches stay useful. */
function nearestIdleSlot(
  slots: readonly WorkerSlot[],
  location: JobLocation,
): WorkerSlot | undefined {
  let best: WorkerSlot | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const slot of slots) {
    if (slot.active !== undefined) continue;
    const last = slot.last;
    const distance =
      last === undefined || last.dimension !== location.dimension
        ? Number.MAX_VALUE
        : (last.x - location.x) ** 2 + (last.z - location.z) ** 2;
    if (best === undefined || distance < bestDistance) {
      best = slot;
      bestDistance = distance;
    }
  }
  return best;
}
