import { Worker } from "node:worker_threads";

import type { RegionBuilderOptions, RegionRequest } from "./region-builder.js";
import type { WorkerReply } from "./worker-protocol.js";

export interface BuiltRegion {
  readonly bytes: Uint8Array;
  /** Time spent inside the worker, excluding queueing. */
  readonly milliseconds: number;
}

interface PendingBuild {
  readonly id: number;
  readonly region: RegionRequest;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (region: BuiltRegion) => void;
  readonly reject: (cause: Error) => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  active: PendingBuild | undefined;
}

/**
 * Runs region builds on worker threads. Queued builds whose signal aborts before
 * a worker picks them up are dropped, so a camera that moves on does not leave
 * stale work in front of the regions it needs now.
 */
export class RegionWorkerPool {
  private readonly options: RegionBuilderOptions;
  private readonly slots: WorkerSlot[] = [];
  private queue: PendingBuild[] = [];
  private nextId = 1;
  private closed = false;

  constructor(options: RegionBuilderOptions, workers: number) {
    this.options = options;
    for (let index = 0; index < workers; index += 1) this.slots.push(this.createSlot());
  }

  build(region: RegionRequest, signal?: AbortSignal): Promise<BuiltRegion> {
    if (this.closed) return Promise.reject(new Error("The region worker pool is closed"));
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const pending: PendingBuild = { id: this.nextId++, region, signal, resolve, reject };
      signal?.addEventListener("abort", () => this.cancel(pending), { once: true });
      this.queue.push(pending);
      this.dispatch();
    });
  }

  /** Builds waiting for a worker. */
  get backlog(): number {
    return this.queue.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue) pending.reject(new Error("The region worker pool closed"));
    this.queue = [];
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private cancel(pending: PendingBuild): void {
    const index = this.queue.indexOf(pending);
    if (index < 0) return;
    this.queue.splice(index, 1);
    pending.reject(abortError());
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(new URL("./region-worker.js", import.meta.url), {
      workerData: this.options,
    });
    const slot: WorkerSlot = { worker, active: undefined };
    worker.unref();
    worker.on("message", (reply: WorkerReply) => this.complete(slot, reply));
    worker.on("error", (cause) => this.fail(slot, cause));
    worker.on("exit", (code) => {
      if (code !== 0 && !this.closed)
        this.fail(slot, new Error(`Region worker exited with ${code}`));
    });
    return slot;
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.active !== undefined) continue;
      const pending = this.queue.shift();
      if (pending === undefined) return;
      slot.active = pending;
      slot.worker.ref();
      slot.worker.postMessage({ id: pending.id, region: pending.region });
    }
  }

  private complete(slot: WorkerSlot, reply: WorkerReply): void {
    const pending = slot.active;
    if (pending === undefined || pending.id !== reply.id) return;
    slot.active = undefined;
    slot.worker.unref();
    if (reply.kind === "built") {
      pending.resolve({ bytes: reply.bytes, milliseconds: reply.milliseconds });
    } else {
      pending.reject(new Error(reply.message));
    }
    this.dispatch();
  }

  private fail(slot: WorkerSlot, cause: Error): void {
    const index = this.slots.indexOf(slot);
    if (index < 0) return;
    this.slots.splice(index, 1);
    slot.active?.reject(cause);
    if (!this.closed) {
      this.slots.push(this.createSlot());
      this.dispatch();
    }
  }
}

function abortError(): Error {
  return new DOMException("The region build was cancelled", "AbortError");
}
