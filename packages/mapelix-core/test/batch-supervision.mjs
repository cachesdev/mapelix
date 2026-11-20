import { Worker, workerData } from "node:worker_threads";

if (workerData.mode === "crash") throw new Error("Expected coordinator crash");
if (workerData.mode === "spin") {
  const counters = new Int32Array(workerData.counters);
  new Worker(
    `
    const { workerData } = require("node:worker_threads");
    const counters = new Int32Array(workerData);
    Atomics.store(counters, 1, 1);
    Atomics.notify(counters, 1);
    setInterval(() => Atomics.add(counters, 0, 1), 2);
  `,
    { eval: true, workerData: workerData.counters },
  );
  while (Atomics.load(counters, 1) === 0) Atomics.wait(counters, 1, 0, 100);
  Atomics.store(counters, 2, 1);
  while (true) Atomics.add(counters, 3, 1);
}
