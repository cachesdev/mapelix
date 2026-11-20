import { mkdir, open, rename, unlink } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { jsonBytes } from "./identity.js";
import {
  assertPublicationTarget,
  generationId,
  publishedManifest,
  verifyGeneration,
} from "./manifest.js";
import { normalizeBatch } from "./options.js";
import {
  acquireOutput,
  assertNoLinks,
  isMissing,
  ownedPath,
  removeOwnedTree,
  validateRoots,
  type OutputLease,
} from "./paths.js";
import { superviseBatch } from "./supervisor.js";
import type { BatchOptions, BatchResult } from "./types.js";

export { DEFAULT_BATCH_LIMITS } from "./options.js";
export type {
  BatchBounds,
  BatchLimits,
  BatchOptions,
  BatchResult,
  BatchManifest,
  BatchTile,
  BatchUpdate,
  PublishedBatchManifest,
} from "./types.js";

/** Bounded read-only rendering followed by a single atomic publication pointer replacement. */
export async function renderBatch(options: BatchOptions): Promise<BatchResult> {
  const batch = normalizeBatch(options);
  const started = performance.now();
  const controller = new AbortController();
  let peakRss = process.memoryUsage.rss();
  const abort = () => controller.abort(new DOMException("Batch render aborted", "AbortError"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted === true) abort();
  const timeout = setTimeout(() => {
    const cause = new Error(`Batch render exceeded timeoutMs (${batch.limits.timeoutMs})`);
    cause.name = "TimeoutError";
    controller.abort(cause);
  }, batch.limits.timeoutMs);
  const checkMemory = () => {
    peakRss = Math.max(peakRss, process.memoryUsage.rss());
    if (peakRss > batch.limits.memoryBudgetMiB * 1024 ** 2) {
      const cause = new Error(
        `Batch render exceeded memoryBudgetMiB (${batch.limits.memoryBudgetMiB})`,
      );
      cause.name = "MemoryLimitError";
      controller.abort(cause);
    }
  };
  const monitor = setInterval(checkMemory, 25);
  const { signal } = controller;
  let lease: OutputLease | undefined;
  let temporaryManifest: string | undefined;
  let unpublished: string | undefined;
  let result: BatchResult | undefined;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    checkMemory();
    signal.throwIfAborted();
    await validateRoots(batch.world, batch.output);
    signal.throwIfAborted();
    lease = await acquireOutput(batch.output);
    await assertPublicationTarget(batch.output);
    signal.throwIfAborted();
    const prepared = await superviseBatch({ batch, stage: lease.stage }, signal);
    signal.throwIfAborted();
    if (
      prepared.generation !== generationId(prepared.manifest) ||
      prepared.publicationBytes > batch.limits.maxOutputBytes
    ) {
      throw new Error("Invalid prepared generation");
    }
    const generations = ownedPath(batch.output, "generations");
    try {
      await mkdir(generations);
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
    }
    await assertNoLinks(generations);
    const destination = ownedPath(batch.output, "generations", prepared.generation);
    let exists = true;
    try {
      await assertNoLinks(destination);
    } catch (cause) {
      if (isMissing(cause)) exists = false;
      else throw cause;
    }
    if (exists) await verifyGeneration(destination, prepared.manifest, signal);
    else {
      signal.throwIfAborted();
      await rename(lease.stage, destination);
      unpublished = destination;
    }
    signal.throwIfAborted();
    const manifest = publishedManifest(prepared.manifest, prepared.generation);
    const manifestPath = ownedPath(batch.output, "manifest.json");
    const temporaryPath = ownedPath(batch.output, `.mapelix-manifest-${lease.token}.tmp`);
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryManifest = temporaryPath;
    try {
      await handle.writeFile(jsonBytes(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await assertPublicationTarget(batch.output);
    signal.throwIfAborted();
    // Readers see the previous complete pointer or the new complete pointer. Success wins once renamed.
    await rename(temporaryManifest, manifestPath);
    temporaryManifest = undefined;
    unpublished = undefined;
    result = {
      manifest,
      update: prepared.update,
      manifestPath,
      elapsedMs: performance.now() - started,
      peakRssMiB: peakRss / 1024 ** 2,
    };
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    options.signal?.removeEventListener("abort", abort);
    try {
      if (temporaryManifest !== undefined)
        await unlink(temporaryManifest).catch((cause: unknown) => {
          if (!isMissing(cause)) throw cause;
        });
    } catch (cause) {
      cleanupErrors.push(cause);
    }
    try {
      if (unpublished !== undefined) await removeOwnedTree(batch.output, unpublished);
    } catch (cause) {
      cleanupErrors.push(cause);
    }
    try {
      await lease?.release();
    } catch (cause) {
      cleanupErrors.push(cause);
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      failed ? [failure, ...cleanupErrors] : cleanupErrors,
      "Batch output cleanup failed; publication may have completed; inspect owned leftovers",
    );
  if (failed) throw failure;
  return { ...result!, elapsedMs: performance.now() - started };
}
