import { Worker } from "node:worker_threads";

import type { IndexedTileRenderJob } from "./node-tile-render.js";
import type { RenderedTile } from "./tile.js";

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
  private nextId = 1;

  constructor(concurrency: number) {
    this.concurrency = concurrency;
    for (let index = 0; index < concurrency; index += 1) {
      this.slots.push(this.createSlot());
    }
  }

  render(job: IndexedTileRenderJob): Promise<RenderedTile> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, job, resolve, reject });
      this.dispatch();
    });
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(new URL("./node-render-worker.js", import.meta.url));
    const slot: WorkerSlot = { worker, active: undefined };
    worker.unref();
    worker.on("message", (response: WorkerResponse) => this.complete(slot, response));
    worker.on("error", (cause) => this.fail(slot, cause));
    worker.on("exit", (code) => {
      if (code !== 0) {
        this.fail(slot, new Error(`Mapelix render worker exited with code ${code}`));
      }
    });
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
    this.slots.push(this.createSlot());
    this.dispatch();
  }
}
