import { parentPort, workerData } from "node:worker_threads";

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

port.on("message", (request: WorkerRequest) => {
  void renderIndexedTile(request.job, {}, undefined, cache)
    .then((tile) => {
      const response: WorkerSuccess = { id: request.id, tile };
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
