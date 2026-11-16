import { Worker } from "node:worker_threads";

import type { IndexedTileRenderJob } from "./node-tile-render.js";
import type { RenderedTile } from "./tile.js";
import { renderAbortError } from "./render-abort.js";
import type { CloseWorldOptions } from "./world.js";

interface WorkerResponse {
  readonly id: number;
  readonly tile?: RenderedTile;
  readonly error?: string;
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
}

export class TileRenderWorkerPool {
  readonly concurrency: number;
  private readonly slots: WorkerSlot[] = [];
  private readonly queue: PendingRender[] = [];
  private readonly pending = new Set<Promise<RenderedTile>>();
  private nextId = 1;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
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
    const worker = new Worker(new URL("./node-render-worker.js", import.meta.url));
    const slot: WorkerSlot = { worker, active: undefined };
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
    for (const slot of this.slots) {
      if (slot.active !== undefined) {
        continue;
      }
      const pending = this.queue.shift();
      if (pending === undefined) {
        return;
      }
      slot.active = pending;
      slot.worker.ref();
      slot.worker.postMessage({ id: pending.id, job: pending.job });
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
