import { parentPort, workerData } from "node:worker_threads";

import { prepareBatch } from "./executor.js";
import type { BatchWorkerInput, BatchWorkerMessage } from "./types.js";

if (parentPort === null) throw new Error("The batch coordinator must run in a worker");
const port = parentPort;
const controller = new AbortController();
port.on("message", () => controller.abort(new DOMException("Batch render aborted", "AbortError")));
try {
  const prepared = await prepareBatch(workerData as BatchWorkerInput, controller);
  const message: BatchWorkerMessage = { type: "ready", prepared };
  port.postMessage(message);
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const message: BatchWorkerMessage = { type: "error", name: error.name, message: error.message };
  port.postMessage(message);
} finally {
  port.close();
}
