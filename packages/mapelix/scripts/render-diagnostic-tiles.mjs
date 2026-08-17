import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";

import { openBedrockWorld } from "../dist/index.js";

const directory = process.env.MAPELIX_DIAGNOSTIC_WORLD;
const outputDirectory = process.env.MAPELIX_DIAGNOSTIC_OUTPUT;
const coordinatesInput = process.env.MAPELIX_DIAGNOSTIC_TILES;
const label = process.env.MAPELIX_DIAGNOSTIC_LABEL ?? "diagnostic";

if (directory === undefined || outputDirectory === undefined || coordinatesInput === undefined) {
  throw new Error(
    "Set MAPELIX_DIAGNOSTIC_WORLD, MAPELIX_DIAGNOSTIC_OUTPUT, and MAPELIX_DIAGNOSTIC_TILES",
  );
}

const coordinates = parseCoordinates(coordinatesInput);
await mkdir(outputDirectory, { recursive: true });

globalThis.gc?.();
const startedAt = performance.now();
const world = await openBedrockWorld({ directory, renderConcurrency: 1 });
const indexedAt = performance.now();
const outputs = [];

for (const coordinate of coordinates) {
  const stem = `${label}-z${coordinate.z}-x${coordinate.x}-y${coordinate.y}`;
  const tileStartedAt = performance.now();
  const shadowless = await world.renderTile(coordinate, {
    includeSurface: true,
    shadows: false,
  });
  const normal = await world.renderTile(coordinate, { shadows: true });
  const shadowlessPath = join(outputDirectory, `${stem}-shadowless.png`);
  const normalPath = join(outputDirectory, `${stem}.png`);
  const surfacePath = join(outputDirectory, `${stem}-surface.json`);
  await Promise.all([
    writeFile(shadowlessPath, shadowless.png),
    writeFile(normalPath, normal.png),
    writeFile(surfacePath, `${JSON.stringify(shadowless.surface)}\n`),
  ]);
  outputs.push({
    coordinate,
    milliseconds: round(performance.now() - tileStartedAt),
    pngBytes: { normal: normal.png.byteLength, shadowless: shadowless.png.byteLength },
    files: {
      normal: normalPath,
      shadowless: shadowlessPath,
      surface: surfacePath,
    },
  });
}

globalThis.gc?.();
const result = {
  world: basename(directory),
  label,
  milliseconds: {
    index: round(indexedAt - startedAt),
    total: round(performance.now() - startedAt),
  },
  memoryBytes: process.memoryUsage(),
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  outputs,
};
console.log(JSON.stringify(result, undefined, 2));

function parseCoordinates(input) {
  const parsed = JSON.parse(input);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError("MAPELIX_DIAGNOSTIC_TILES must be a non-empty JSON array");
  }
  return parsed.map((coordinate) => {
    if (
      typeof coordinate !== "object" ||
      coordinate === null ||
      ![coordinate.z, coordinate.x, coordinate.y].every(Number.isSafeInteger)
    ) {
      throw new TypeError("Each diagnostic tile needs integer z, x, and y fields");
    }
    return { dimension: "overworld", z: coordinate.z, x: coordinate.x, y: coordinate.y };
  });
}

function round(value) {
  return Math.round(value * 100) / 100;
}
