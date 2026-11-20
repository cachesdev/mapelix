import { parentPort, workerData } from "node:worker_threads";
import { PrototypeBuilder } from "./prototype.mjs";
const builders = new Map();
parentPort.on("message", ({ id, request, keepBytes }) => {
  try {
    const dimension = request.dimension ?? "overworld";
    let builder = builders.get(dimension);
    if (!builder)
      builders.set(
        dimension,
        (builder = new PrototypeBuilder(workerData.directory, dimension)),
      );
    const start = performance.now();
    const bytes = builder.build(request);
    if (request.collectGarbage) global.gc?.();
    parentPort.postMessage(
      {
        id,
        milliseconds: performance.now() - start,
        byteLength: bytes.length,
        timings: builder.timings,
        memory: process.memoryUsage(),
        ...(keepBytes ? { bytes } : {}),
      },
      keepBytes ? [bytes.buffer] : [],
    );
  } catch (error) {
    parentPort.postMessage({ id, error: error.stack });
  }
});
