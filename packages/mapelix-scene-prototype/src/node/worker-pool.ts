import { Worker } from "node:worker_threads";
import type { BlockRequest } from "./worker-protocol.js";

import type { RegionBuilderOptions, RegionRequest } from "./region-builder.js";
import type { WorkerReply, WorkerPayload } from "./worker-protocol.js";
import type { DiscoveryRequest } from "../discoveries.js";

export interface BuiltRegion {
  readonly bytes: Uint8Array;
  /** Time spent inside the worker, excluding queueing. */
  readonly milliseconds: number;
}

interface PendingBuild {
  readonly id: number;
  readonly payload: WorkerPayload;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (region: BuiltRegion) => void;
  readonly reject: (cause: Error) => void;
  readonly unsubscribe: () => void;
  cancelled: boolean;
}

interface WorkerSlot {
  readonly worker: Worker;
  active: PendingBuild | undefined;
  /** The texture index this worker holds, sent with its first textured build. */
  textures: string | undefined;
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
    return this.enqueue({ region }, signal);
  }

  discoveries(discoveries: DiscoveryRequest, signal?: AbortSignal): Promise<BuiltRegion> {
    return this.enqueue({ discoveries }, signal);
  }

  block(block: BlockRequest, signal?: AbortSignal): Promise<BuiltRegion> {
    return this.enqueue({ block }, signal);
  }

  private enqueue(payload: WorkerPayload, signal?: AbortSignal): Promise<BuiltRegion> {
    if (this.closed) return Promise.reject(new Error("The region worker pool is closed"));
    if (signal?.aborted === true) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => this.cancel(pending);
      const pending: PendingBuild = {
        id: this.nextId++,
        payload,
        signal,
        resolve,
        reject,
        cancelled: false,
        unsubscribe: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      const firstDiscovery = this.queue.findIndex((job) => "discoveries" in job.payload);
      if ("region" in payload && firstDiscovery >= 0) this.queue.splice(firstDiscovery, 0, pending);
      else this.queue.push(pending);
      this.dispatch();
    });
  }

  /** Builds waiting for a worker. */
  get backlog(): number {
    return this.queue.length;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of [
      ...this.queue,
      ...this.slots.flatMap((slot) => (slot.active ? [slot.active] : [])),
    ]) {
      pending.unsubscribe();
      pending.reject(new Error("The region worker pool closed"));
    }
    this.queue = [];
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }

  private cancel(pending: PendingBuild): void {
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
    pending.cancelled = true;
    pending.unsubscribe();
    pending.reject(abortError());
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(new URL("./region-worker.js", import.meta.url), {
      workerData: this.options,
    });
    const slot: WorkerSlot = { worker, active: undefined, textures: undefined };
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
      let { payload } = pending;
      const textures = "region" in payload ? payload.region.textures : undefined;
      if (typeof textures === "object") {
        // The index is large: each worker receives it once, then its fingerprint.
        if (slot.textures === textures.fingerprint) {
          payload = {
            region: {
              ...(payload as { region: RegionRequest }).region,
              textures: textures.fingerprint,
            },
          };
        } else {
          slot.textures = textures.fingerprint;
        }
      }
      slot.worker.postMessage({ id: pending.id, ...payload });
    }
  }

  private complete(slot: WorkerSlot, reply: WorkerReply): void {
    const pending = slot.active;
    if (pending === undefined || pending.id !== reply.id) return;
    slot.active = undefined;
    pending.unsubscribe();
    slot.worker.unref();
    if (pending.cancelled) {
      this.dispatch();
      return;
    }
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
    slot.active?.unsubscribe();
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
