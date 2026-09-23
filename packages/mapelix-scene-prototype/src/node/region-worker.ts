import { parentPort, workerData } from "node:worker_threads";

import { parseWorkerSetup, type WorkerReply, type WorkerRequest } from "./worker-protocol.js";
import { RegionBuilder } from "./region-builder.js";

const port = parentPort;
if (port === null) throw new Error("The scene region worker must run in a worker thread");

const builder = new RegionBuilder(parseWorkerSetup(workerData));

port.on("message", (request: WorkerRequest) => {
  let reply: WorkerReply;
  try {
    const startedAt = performance.now();
    const bytes = builder.build(request.region);
    reply = { id: request.id, kind: "built", bytes, milliseconds: performance.now() - startedAt };
    port.postMessage(reply, [bytes.buffer as ArrayBuffer]);
  } catch (cause) {
    const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    reply = { id: request.id, kind: "failed", message };
    port.postMessage(reply);
  }
});
