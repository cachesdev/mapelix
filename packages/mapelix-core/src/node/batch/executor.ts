import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { openMapWorld } from "../index.js";
import { jsonBytes, rendererIdentity, sha256, sourceIdentity } from "./identity.js";
import { generationId, publishedManifest, verifyGeneration } from "./manifest.js";
import { assertNoLinks, ownedPath } from "./paths.js";
import { planTiles, tilePath } from "./plan.js";
import type { BatchManifest, BatchTile, BatchWorkerInput, PreparedBatch } from "./types.js";

/** Runs only in the supervised coordinator; no publication can occur from this worker. */
export async function prepareBatch(
  input: BatchWorkerInput,
  controller: AbortController,
): Promise<PreparedBatch> {
  const { batch, stage } = input;
  const { signal } = controller;
  const source = await sourceIdentity(batch.world, batch.limits.maxInputFileBytes, signal);
  const renderer = await rendererIdentity();
  signal.throwIfAborted();
  const world = await openMapWorld({
    directory: batch.world,
    renderConcurrency: batch.limits.workers,
    forceWorkers: true,
    signal,
  });
  const abort = () => {
    void world.close({ abort: true }).catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const plan = planTiles(world, batch);
    const tiles: BatchTile[] = [];
    let next = 0;
    let pngBytes = 0;
    let failure: unknown;
    const renderNext = async (): Promise<void> => {
      try {
        while (next < plan.length) {
          signal.throwIfAborted();
          const index = next++;
          const coordinates = plan[index]!;
          const profile = batch.profiles.find(
            (value) => value.dimension === coordinates.dimension,
          )!;
          const tile = await world.renderTile(coordinates, {
            topY: profile.topY,
            appearance: batch.appearance,
            shadows: batch.shadows !== "off",
            biomeBlendRadius: batch.biomeBlendRadius,
            correctReferenceBugs: batch.correctReferenceBugs,
          });
          signal.throwIfAborted();
          if (tile.width !== 256 || tile.height !== 256)
            throw new Error("Renderer returned an invalid tile size");
          pngBytes += tile.png.byteLength;
          if (pngBytes > batch.limits.maxOutputBytes)
            throw new RangeError("PNG output exceeds maxOutputBytes");
          const path = tilePath(coordinates);
          const destination = ownedPath(stage, path);
          await mkdir(dirname(destination), { recursive: true });
          await assertNoLinks(destination, true);
          signal.throwIfAborted();
          await writeFile(destination, tile.png, { flag: "wx", signal });
          tiles[index] = {
            ...coordinates,
            path,
            bytes: tile.png.byteLength,
            sha256: sha256(tile.png),
          };
        }
      } catch (cause) {
        failure ??= cause;
        controller.abort(cause);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(plan.length, batch.limits.maxPending) }, renderNext),
    );
    if (failure !== undefined) throw failure;
    signal.throwIfAborted();
    const after = await sourceIdentity(batch.world, batch.limits.maxInputFileBytes, signal);
    if (after.revision !== source.revision)
      throw new Error("Source snapshot changed during rendering");
    const manifest: BatchManifest = {
      format: "mapelix-2d",
      schemaVersion: 1,
      complete: true,
      renderer: { name: "@mapelix/core", version: "0.0.0", revision: renderer.revision },
      resources: { appearanceSha256: renderer.appearanceSha256 },
      source,
      grid: {
        scheme: "xyz",
        tileSize: 256,
        xAxis: "east",
        yAxis: "south",
        pixelsPerBlock: "2^zoom",
        zooms: batch.zooms,
      },
      render: {
        profiles: batch.profiles,
        appearance: batch.appearance,
        shadows: batch.shadows,
        biomeBlendRadius: batch.biomeBlendRadius,
        correctReferenceBugs: batch.correctReferenceBugs,
        bounds: batch.bounds,
      },
      tileCount: tiles.length,
      pngBytes,
      tiles,
    };
    const generation = generationId(manifest);
    const bytes = jsonBytes(manifest);
    const publicationBytes =
      pngBytes +
      Buffer.byteLength(bytes) +
      Buffer.byteLength(jsonBytes(publishedManifest(manifest, generation)));
    if (publicationBytes > batch.limits.maxOutputBytes)
      throw new RangeError("Manifest and PNG output exceeds maxOutputBytes");
    await writeFile(ownedPath(stage, "manifest.json"), bytes, { flag: "wx", signal });
    await verifyGeneration(stage, manifest, signal);
    return { manifest, generation, publicationBytes };
  } finally {
    signal.removeEventListener("abort", abort);
    await world.close({ abort: signal.aborted });
  }
}
