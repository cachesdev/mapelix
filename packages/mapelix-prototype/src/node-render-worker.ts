import { parentPort, workerData } from "node:worker_threads";

import { SurfaceStoreReader, type StoredSurfaceEntry } from "./chunk-surface-store.js";
import { renderIndexedTile, type IndexedTileRenderJob } from "./node-tile-render.js";
import type { RenderedTile } from "./tile.js";
import { TileRenderCache } from "./tile-render-cache.js";

interface WorkerOptions {
  readonly renderCacheMiB?: number;
}

interface WorkerRequest {
  readonly id: number;
  readonly job: IndexedTileRenderJob;
}

interface WorkerSuccess {
  readonly id: number;
  readonly tile: RenderedTile;
  readonly surfaces?: readonly StoredSurfaceEntry[];
  readonly surfaceStats?: {
    readonly hits: number;
    readonly stored: number;
    readonly rejected: number;
  };
}

interface WorkerFailure {
  readonly id: number;
  readonly error: string;
}

const port = parentPort;
if (port === null) {
  throw new Error("Mapelix render worker must run in a Node worker thread");
}

// One cache per worker: the pool keeps a worker for the lifetime of one opened world.
const cache = new TileRenderCache((workerData as WorkerOptions | undefined)?.renderCacheMiB);
const store = new SurfaceStoreReader();

port.on("message", (request: WorkerRequest) => {
  void renderIndexedTile(request.job, {}, undefined, cache, store)
    .then((tile) => {
      const response: WorkerSuccess =
        request.job.surfaceStore === undefined
          ? { id: request.id, tile }
          : { id: request.id, tile, surfaces: store.drain(), surfaceStats: store.drainStats() };
      // PNG encoders can return a small pooled Buffer whose backing store Node marks untransferable.
      // Clone the compressed PNG and transfer only the renderer-owned RGBA allocation.
      port.postMessage(response, [tile.rgba.buffer as ArrayBuffer]);
    })
    .catch((cause: unknown) => {
      const response: WorkerFailure = {
        id: request.id,
        error: cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
      };
      port.postMessage(response);
    });
});
