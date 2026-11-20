import { Worker } from "node:worker_threads";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { renderBatch } from "../dist/node/batch/index.js";

const [world, output, mode] = process.argv.slice(2);
if (mode === "publish-error") {
  const rename = Reflect.get(fs, "rename");
  fs.rename = async (source, destination) => {
    if (String(destination).endsWith("manifest.json"))
      throw new Error("Expected publication rename failure");
    return rename(source, destination);
  };
  syncBuiltinESMExports();
}
if (mode === "crash") {
  const on = Reflect.get(Worker.prototype, "on");
  let armed = true;
  Worker.prototype.on = function (event, listener) {
    if (armed && event === "message") {
      armed = false;
      on.call(this, "online", () => {
        void this.terminate();
      });
    }
    return on.call(this, event, listener);
  };
}
const controller = new AbortController();
const timer = mode === "abort" ? setTimeout(() => controller.abort(), 150) : undefined;
try {
  await renderBatch({
    world,
    output,
    zooms: [mode === "publish-error" ? 0 : 3],
    limits: {
      workers: 1,
      ...(mode === "timeout" ? { timeoutMs: 150 } : {}),
      ...(mode === "memory"
        ? { memoryBudgetMiB: Math.ceil(process.memoryUsage.rss() / 1024 ** 2) + 4 }
        : {}),
    },
    signal: controller.signal,
  });
  throw new Error("Expected batch failure");
} catch (cause) {
  console.log(
    JSON.stringify({
      name: cause.name,
      message: cause.message,
      ports: process.getActiveResourcesInfo().filter((name) => name === "MessagePort").length,
    }),
  );
} finally {
  clearTimeout(timer);
}
