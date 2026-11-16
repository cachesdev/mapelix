import { createHash } from "node:crypto";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { openBedrockWorld } from "../dist/index.js";

const [directory, scenario, concurrency] = process.argv.slice(2);
let terminated = 0;
const terminate = Reflect.get(Worker.prototype, "terminate");
Worker.prototype.terminate = function () {
  terminated += 1;
  return terminate.call(this);
};

if (scenario.startsWith("worker-exit")) {
  const postMessage = Reflect.get(Worker.prototype, "postMessage");
  let interrupted = false;
  Worker.prototype.postMessage = function (...args) {
    if (!interrupted) {
      interrupted = true;
      void terminate.call(this);
      return;
    }
    return postMessage.apply(this, args);
  };
}

const world = await openBedrockWorld({ directory, renderConcurrency: Number(concurrency) });
const coordinates = { dimension: "overworld", z: 2, x: 0, y: 0 };
const messagePorts = () =>
  process.getActiveResourcesInfo().filter((name) => name === "MessagePort").length;
const abort = scenario.startsWith("abort");

if (scenario === "read-error-idle" || scenario === "worker-exit-idle") {
  if (scenario === "read-error-idle") {
    await rename(join(directory, "db", "000001.log"), join(directory, "db", "000001.saved"));
  }
  let failure;
  try {
    await world.renderTile(coordinates);
  } catch (cause) {
    failure = cause.message;
  }
  console.log(JSON.stringify({ completed: true, terminated, failure }));
} else if (scenario === "idle" || scenario === "unused") {
  if (scenario === "idle") await world.renderTile(coordinates);
  else await world.close();
  console.log(JSON.stringify({ completed: true, terminated, messagePorts: messagePorts() }));
} else {
  const pending = [
    world.renderTile(coordinates),
    world.renderTile(coordinates),
    world.renderTile(coordinates, scenario === "drain" || abort ? { shadows: false } : {}),
    world.renderTile(
      coordinates,
      scenario === "drain"
        ? {
            resolveBlockStyle() {
              throw new Error("Expected render failure");
            },
          }
        : {},
    ),
    world.renderTile(coordinates),
  ];
  const completed = Promise.allSettled(pending);
  // Yield so the main-process reader can start an asynchronous file read before cancellation.
  if (abort) await new Promise((resolve) => setImmediate(resolve));
  const closing = world.close({ abort: scenario === "abort" });
  const sameClosePromise = closing === world.close({ abort });
  let rejectedAfterClose = false;
  try {
    await world.renderTile(coordinates);
  } catch (cause) {
    rejectedAfterClose = cause.message === "The Bedrock world is closed";
  }
  let coverageRejected = false;
  try {
    world.getTileCoverage("overworld");
  } catch (cause) {
    coverageRejected = cause.message === "The Bedrock world is closed";
  }
  await closing;
  const results = await completed;
  const tiles = results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  console.log(
    JSON.stringify({
      fulfilled: tiles.length,
      rejected: results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason.message),
      rejectedNames: results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason.name),
      identicalPngs:
        new Set(tiles.map((tile) => createHash("sha256").update(tile.png).digest("hex"))).size ===
        1,
      sameClosePromise,
      terminated,
      messagePorts: messagePorts(),
      rejectedAfterClose,
      coverageRejected,
    }),
  );
}
