import { performance } from "node:perf_hooks";
import process from "node:process";

import { MAX_NATIVE_ZOOM, openBedrockWorld } from "../dist/index.js";

const directory = process.env.MAPELIX_BENCH_WORLD;
if (!directory) {
  throw new Error("Set MAPELIX_BENCH_WORLD to an extracted Bedrock world directory");
}

const renderConcurrency = positiveInteger(process.env.MAPELIX_BENCH_WORKERS ?? "1", "workers");
const indexStartedAt = performance.now();
const world = await openBedrockWorld({ directory, renderConcurrency });
const indexMilliseconds = performance.now() - indexStartedAt;
const hotspot = world
  .getTileCoverage("overworld")
  .reduce((best, tile) => (tile.subchunkCount > best.subchunkCount ? tile : best));
const zooms = [];

for (let zoom = 0; zoom <= MAX_NATIVE_ZOOM; zoom += 1) {
  const scale = 2 ** zoom;
  const coordinates = {
    dimension: "overworld",
    z: zoom,
    x: hotspot.x * scale + Math.floor(scale / 2),
    y: hotspot.y * scale + Math.floor(scale / 2),
  };
  globalThis.gc?.();
  const before = memorySnapshot();
  const first = await timedRender(world, coordinates);
  const repeated = await timedRender(world, coordinates);
  const after = memorySnapshot();
  zooms.push({
    zoom,
    pixelsPerBlock: scale,
    blocksPerTile: 256 / scale,
    coordinates,
    bounds: first.tile.bounds,
    pngBytes: first.tile.png.byteLength,
    milliseconds: {
      first: round(first.milliseconds),
      repeated: round(repeated.milliseconds),
    },
    memoryBytes: { before, after },
  });
}

console.log(
  JSON.stringify(
    {
      runtime: { node: process.version, platform: process.platform, architecture: process.arch },
      world: directory,
      configuration: { renderConcurrency },
      hotspot,
      indexMilliseconds: round(indexMilliseconds),
      zooms,
      peakRss: process.resourceUsage().maxRSS * 1024,
    },
    undefined,
    2,
  ),
);

async function timedRender(world, coordinates) {
  const startedAt = performance.now();
  const tile = await world.renderTile(coordinates);
  return { tile, milliseconds: performance.now() - startedAt };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Benchmark ${label} must be a positive integer, received ${raw}`);
  }
  return value;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
