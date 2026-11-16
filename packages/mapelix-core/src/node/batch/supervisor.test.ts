import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { normalizeBatch } from "./options.js";
import { superviseBatch } from "./supervisor.js";

const workerURL = new URL("../../../test/batch-supervision.mjs", import.meta.url);
const input = {
  batch: normalizeBatch({ world: "unused", output: "unused-output" }),
  stage: "unused-stage",
};

describe("batch coordinator supervision", () => {
  it.each(["crash", "empty"])("settles a %s coordinator after it exits", async (mode) => {
    const request = { ...input, mode };
    await expect(superviseBatch(request, new AbortController().signal, workerURL)).rejects.toThrow(
      mode === "crash" ? "Expected coordinator crash" : "without a result",
    );
  });

  it("terminates CPU-bound indexing and nested workers before rejecting cancellation", async () => {
    const counters = new Int32Array(new SharedArrayBuffer(16));
    const controller = new AbortController();
    const request = { ...input, mode: "spin", counters: counters.buffer };
    const pending = superviseBatch(request, controller.signal, workerURL);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    try {
      for (let wait = 0; wait < 200 && Atomics.load(counters, 2) === 0; wait++) await delay(10);
      expect(Atomics.load(counters, 2)).toBe(1);
    } finally {
      controller.abort();
    }
    await rejected;
    const stopped = Atomics.load(counters, 0);
    const stoppedCpu = Atomics.load(counters, 3);
    await delay(80);
    expect(Atomics.load(counters, 0)).toBe(stopped);
    expect(Atomics.load(counters, 3)).toBe(stoppedCpu);
  }, 10_000);
});
