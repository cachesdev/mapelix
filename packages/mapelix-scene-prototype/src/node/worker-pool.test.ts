import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerRequest, WorkerReply } from "./worker-protocol.js";

const workers = vi.hoisted(() => [] as Array<{ sent: WorkerRequest[]; complete(): void }>);
vi.mock("node:worker_threads", () => ({
  Worker: class {
    readonly sent: WorkerRequest[] = [];
    private listener: ((message: WorkerReply) => void) | undefined;
    constructor() {
      workers.push(this);
    }
    on(event: string, listener: (message: WorkerReply) => void) {
      if (event === "message") this.listener = listener;
    }
    unref() {}
    ref() {}
    async terminate() {
      return 0;
    }
    postMessage(message: WorkerRequest) {
      this.sent.push(message);
    }
    complete() {
      const request = this.sent.at(-1)!;
      this.listener?.({ id: request.id, kind: "built", bytes: new Uint8Array(0), milliseconds: 1 });
    }
  },
}));
import { RegionWorkerPool } from "./worker-pool.js";
afterEach(() => {
  workers.length = 0;
});

describe("shared terrain/discovery worker scheduling", () => {
  it("lets active indexing finish but prioritizes queued terrain over later indexes", async () => {
    const pool = new RegionWorkerPool({ directory: "/fixture", dimension: "overworld" }, 1);
    const first = pool.discoveries({ x: 0, z: 0 });
    const last = pool.discoveries({ x: 1, z: 0 });
    const terrain = pool.build({ level: 0, x: 0, z: 0 });
    const worker = workers[0]!;
    expect(pool.backlog).toBe(2);
    worker.complete();
    await first;
    expect(worker.sent.at(-1)).toHaveProperty("region");
    worker.complete();
    await terrain;
    expect(worker.sent.at(-1)).toHaveProperty("discoveries", { x: 1, z: 0 });
    worker.complete();
    await last;
    await pool.close();
  });
  it("drops cancelled queued work and removes its abort listener", async () => {
    const pool = new RegionWorkerPool({ directory: "/fixture", dimension: "overworld" }, 1);
    const active = pool.build({ level: 0, x: 0, z: 0 });
    const controller = new AbortController(),
      remove = vi.spyOn(controller.signal, "removeEventListener");
    const cancelled = pool.discoveries({ x: 0, z: 0 }, controller.signal);
    const check = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await check;
    expect(pool.backlog).toBe(0);
    expect(remove).toHaveBeenCalledOnce();
    workers[0]!.complete();
    await active;
    expect(workers[0]!.sent).toHaveLength(1);
    await pool.close();
  });
  it("settles active and queued promises when the pool closes", async () => {
    const pool = new RegionWorkerPool({ directory: "/fixture", dimension: "overworld" }, 1);
    const active = pool.build({ level: 0, x: 0, z: 0 }),
      queued = pool.discoveries({ x: 0, z: 0 });
    const checks = [
      expect(active).rejects.toThrow("closed"),
      expect(queued).rejects.toThrow("closed"),
    ];
    await pool.close();
    await Promise.all(checks);
    await expect(pool.discoveries({ x: 0, z: 0 })).rejects.toThrow("closed");
  });
});
