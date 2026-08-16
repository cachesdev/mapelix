import { performance } from "node:perf_hooks";
import process from "node:process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { openBedrockWorld } from "../dist/index.js";

const directory = process.env.MAPELIX_BENCH_WORLD;
if (!directory) {
  throw new Error("Set MAPELIX_BENCH_WORLD to an extracted Bedrock world directory");
}

const renderConcurrency = positiveInteger(process.env.MAPELIX_BENCH_WORKERS ?? "1", "workers");
const tileCount = positiveInteger(process.env.MAPELIX_BENCH_TILES ?? "1", "tile count");
const database = await databaseSize(directory);

globalThis.gc?.();
const initialResources = process.resourceUsage();
const initialCpu = process.cpuUsage();
const startedAt = performance.now();
const world = await openBedrockWorld({ directory, renderConcurrency });
const indexedAt = performance.now();
const indexCpu = process.cpuUsage(initialCpu);
const afterIndexMemory = memorySnapshot();
const coverage = world.getTileCoverage("overworld");
const selectedTiles = [...coverage]
  .sort((left, right) => right.subchunkCount - left.subchunkCount)
  .slice(0, tileCount);

const firstRenderStartedAt = performance.now();
const firstRenderCpuStarted = process.cpuUsage();
const firstResults = await renderSelectedTiles(world, selectedTiles);
const firstRenderEndedAt = performance.now();
const firstRenderCpu = process.cpuUsage(firstRenderCpuStarted);
const afterFirstRenderMemory = memorySnapshot();

const repeatedRenderStartedAt = performance.now();
const repeatedRenderCpuStarted = process.cpuUsage();
const repeatedResults = await renderSelectedTiles(world, selectedTiles);
const repeatedRenderEndedAt = performance.now();
const repeatedRenderCpu = process.cpuUsage(repeatedRenderCpuStarted);
const afterRepeatedRenderMemory = memorySnapshot();
globalThis.gc?.();

const afterGcMemory = memorySnapshot();
const finalResources = process.resourceUsage();
const firstRenderMilliseconds = firstRenderEndedAt - firstRenderStartedAt;
const repeatedRenderMilliseconds = repeatedRenderEndedAt - repeatedRenderStartedAt;
const result = {
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  world: directory,
  configuration: { renderConcurrency, tileCount },
  data: {
    database,
    tiles: coverage.length,
    subchunks: coverage.reduce((total, tile) => total + tile.subchunkCount, 0),
    selectedSubchunks: selectedTiles.reduce((total, tile) => total + tile.subchunkCount, 0),
    selectedTiles,
    pngBytes: firstResults.reduce((total, result) => total + result.tile.png.byteLength, 0),
  },
  milliseconds: {
    index: round(indexedAt - startedAt),
    firstRender: round(firstRenderMilliseconds),
    repeatedRender: round(repeatedRenderMilliseconds),
    total: round(repeatedRenderEndedAt - startedAt),
  },
  cpuMilliseconds: {
    index: cpuMilliseconds(indexCpu),
    firstRender: cpuMilliseconds(firstRenderCpu),
    repeatedRender: cpuMilliseconds(repeatedRenderCpu),
  },
  cpuUtilization: {
    index: utilization(indexCpu, indexedAt - startedAt),
    firstRender: utilization(firstRenderCpu, firstRenderMilliseconds),
    repeatedRender: utilization(repeatedRenderCpu, repeatedRenderMilliseconds),
  },
  tileLatencyMilliseconds: {
    first: summarize(firstResults.map((result) => result.milliseconds)),
    repeated: summarize(repeatedResults.map((result) => result.milliseconds)),
  },
  throughputTilesPerSecond: {
    first: round((tileCount * 1000) / firstRenderMilliseconds),
    repeated: round((tileCount * 1000) / repeatedRenderMilliseconds),
  },
  memoryBytes: {
    peakRss: finalResources.maxRSS * 1024,
    afterIndex: afterIndexMemory,
    afterFirstRender: afterFirstRenderMemory,
    afterRepeatedRender: afterRepeatedRenderMemory,
    afterGc: afterGcMemory,
  },
  resources: {
    minorPageFaults: finalResources.minorPageFault - initialResources.minorPageFault,
    majorPageFaults: finalResources.majorPageFault - initialResources.majorPageFault,
    filesystemReads: finalResources.fsRead - initialResources.fsRead,
    filesystemWrites: finalResources.fsWrite - initialResources.fsWrite,
    voluntaryContextSwitches:
      finalResources.voluntaryContextSwitches - initialResources.voluntaryContextSwitches,
    involuntaryContextSwitches:
      finalResources.involuntaryContextSwitches - initialResources.involuntaryContextSwitches,
  },
};

console.log(JSON.stringify(result, undefined, 2));

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

async function renderSelectedTiles(world, selectedTiles) {
  return Promise.all(
    selectedTiles.map(async (tile) => {
      const startedAt = performance.now();
      const rendered = await world.renderTile({
        dimension: "overworld",
        z: 0,
        x: tile.x,
        y: tile.y,
      });
      return { tile: rendered, milliseconds: performance.now() - startedAt };
    }),
  );
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rss: memory.rss,
    heapTotal: memory.heapTotal,
    heapUsed: memory.heapUsed,
    external: memory.external,
    arrayBuffers: memory.arrayBuffers,
  };
}

function cpuMilliseconds(usage) {
  return {
    user: round(usage.user / 1000),
    system: round(usage.system / 1000),
    total: round((usage.user + usage.system) / 1000),
  };
}

function utilization(usage, wallMilliseconds) {
  return round((usage.user + usage.system) / 1000 / wallMilliseconds);
}

async function databaseSize(worldDirectory) {
  const databaseDirectory = join(worldDirectory, "db");
  const entries = (await readdir(databaseDirectory, { withFileTypes: true })).filter(
    (entry) =>
      entry.isFile() &&
      (entry.name.endsWith(".ldb") || entry.name.endsWith(".sst") || entry.name.endsWith(".log")),
  );
  const sizes = await Promise.all(
    entries.map(async (entry) => (await stat(join(databaseDirectory, entry.name))).size),
  );
  return {
    files: entries.length,
    bytes: sizes.reduce((total, size) => total + size, 0),
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    minimum: round(sorted[0] ?? 0),
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    maximum: round(sorted.at(-1) ?? 0),
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return round(sorted[index]);
}
