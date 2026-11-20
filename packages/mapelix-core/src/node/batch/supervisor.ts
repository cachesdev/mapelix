import { Worker } from "node:worker_threads";

import type { BatchWorkerInput, BatchWorkerMessage, PreparedBatch } from "./types.js";

/** The deadline stays responsive while the coordinator indexes CPU-bound database records. */
export function superviseBatch(
  input: BatchWorkerInput,
  signal: AbortSignal,
  workerURL = new URL("./worker.js", import.meta.url),
): Promise<PreparedBatch> {
  signal.throwIfAborted();
  const worker = new Worker(workerURL, { workerData: input });
  return new Promise((resolve, reject) => {
    let prepared: PreparedBatch | undefined;
    let failure: Error | undefined;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      worker.postMessage({ type: "abort" });
      abortTimer ??= setTimeout(() => {
        void worker.terminate();
      }, 250);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: BatchWorkerMessage) => {
      if (message.type === "ready") prepared = message.prepared;
      else {
        failure = new Error(message.message);
        failure.name = message.name;
      }
    });
    worker.on("error", (cause) => {
      failure = cause;
    });
    worker.on("exit", (code) => {
      signal.removeEventListener("abort", abort);
      clearTimeout(abortTimer);
      if (signal.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else if (code !== 0 || prepared === undefined)
        reject(new Error(`Batch coordinator exited without a result (code ${code})`));
      else resolve(prepared);
    });
    if (signal.aborted) abort();
  });
}
