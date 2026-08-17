import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const suiteDirectory = join(packageDirectory, "test", "visual-regression");
const manifest = JSON.parse(await readFile(join(suiteDirectory, "manifest.json"), "utf8"));
const outputDirectory = process.env.MAPELIX_VISUAL_OUTPUT ?? "/tmp/mapelix-visual-regression";
const suppliedCandidates = process.env.MAPELIX_VISUAL_CANDIDATES;
const worldDirectory = process.env.MAPELIX_VISUAL_WORLD;

await mkdir(outputDirectory, { recursive: true });
const candidateDirectory =
  worldDirectory === undefined
    ? suppliedCandidates
    : await renderCandidates(worldDirectory, outputDirectory, manifest.scenes);

const results = [];
for (const scene of manifest.scenes) {
  const sceneDirectory = join(suiteDirectory, "scenes", scene.id);
  const candidate = candidateFiles(sceneDirectory, candidateDirectory, scene.id);
  const oracle = {
    normal: join(sceneDirectory, "unmined.png"),
    shadowless: join(sceneDirectory, "unmined-shadowless.png"),
  };
  const outputPrefix = join(outputDirectory, scene.id);
  const [structure, color, shadow] = await Promise.all([
    runJson(
      "compare-renderers.mjs",
      [
        candidate.normal,
        oracle.normal,
        `${outputPrefix}-edges.png`,
        String(manifest.pixelsPerBlock),
        `${outputPrefix}-structure.json`,
      ],
      `${outputPrefix}-structure.json`,
    ),
    runJson(
      "measure-block-colors.mjs",
      [
        candidate.shadowless,
        oracle.shadowless,
        `${outputPrefix}-color.png`,
        String(manifest.pixelsPerBlock),
        String(scene.x),
        String(scene.y),
        `${outputPrefix}-color.json`,
        candidate.surface,
      ],
      `${outputPrefix}-color.json`,
    ),
    runJson(
      "measure-shadows.mjs",
      [
        candidate.normal,
        candidate.shadowless,
        oracle.normal,
        oracle.shadowless,
        `${outputPrefix}-shadows.png`,
        String(manifest.pixelsPerBlock),
        String(scene.x),
        String(scene.y),
        `${outputPrefix}-shadows.json`,
        candidate.surface,
      ],
      `${outputPrefix}-shadows.json`,
    ),
  ]);
  results.push(summarize(scene, structure, color, shadow));
}

const failures = results.flatMap((result) => result.failures);
const report = {
  schemaVersion: manifest.schemaVersion,
  oracle: manifest.oracle,
  candidate: worldDirectory ?? suppliedCandidates ?? "committed Mapelix prototype baseline",
  outputDirectory,
  passed: failures.length === 0,
  scenes: results,
  failures,
};
await writeFile(join(outputDirectory, "report.json"), `${JSON.stringify(report, undefined, 2)}\n`);
for (const result of results) {
  const metrics = result.metrics;
  console.log(
    `${result.failures.length === 0 ? "PASS" : "FAIL"} ${result.id}: ` +
      `edge=${fixed(metrics.edgeF1)} color=${fixed(metrics.meanPerceptualColorError)} ` +
      `shadow=${fixed(metrics.shadowF1)} alignment=${metrics.alignment.x},${metrics.alignment.y}`,
  );
}
console.log(`Report: ${join(outputDirectory, "report.json")}`);
if (failures.length > 0) process.exitCode = 1;

function candidateFiles(sceneDirectory, directory, id) {
  if (directory === undefined) {
    return {
      normal: join(sceneDirectory, "mapelix-baseline.png"),
      shadowless: join(sceneDirectory, "mapelix-baseline-shadowless.png"),
      surface: join(sceneDirectory, "mapelix-baseline-surface.json"),
    };
  }
  return {
    normal: join(directory, `${id}.png`),
    shadowless: join(directory, `${id}-shadowless.png`),
    surface: join(directory, `${id}-surface.json`),
  };
}

async function renderCandidates(directory, output, scenes) {
  const { openBedrockWorld } = await import("../dist/index.js");
  const workers = positiveInteger(process.env.MAPELIX_VISUAL_WORKERS ?? "1", "workers");
  const world = await openBedrockWorld({ directory, renderConcurrency: workers });
  for (const scene of scenes) {
    const coordinates = {
      dimension: "overworld",
      z: 2,
      x: scene.x,
      y: scene.y,
    };
    const normal = await world.renderTile(coordinates);
    const shadowless = await world.renderTile(coordinates, {
      includeSurface: true,
      shadows: false,
    });
    await Promise.all([
      writeFile(join(output, `${scene.id}.png`), normal.png),
      writeFile(join(output, `${scene.id}-shadowless.png`), shadowless.png),
      writeFile(
        join(output, `${scene.id}-surface.json`),
        `${JSON.stringify(shadowless.surface)}\n`,
      ),
    ]);
  }
  return output;
}

async function runJson(script, arguments_, reportPath) {
  const { stdout } = await execute(
    process.execPath,
    [join(packageDirectory, "scripts", script), ...arguments_],
    {
      cwd: packageDirectory,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const source = reportPath === undefined ? stdout : await readFile(reportPath, "utf8");
  if (source.trim() === "") {
    throw new Error(`${script} returned no JSON for ${arguments_[0]}`);
  }
  return JSON.parse(source);
}

function summarize(scene, structure, color, shadow) {
  const metrics = {
    alignment: structure.alignment.bestOffsetPixels,
    edgeF1: structure.alignment.exact.f1,
    tolerantEdgeF1: structure.alignment.withinOnePixelAtBestOffset.f1,
    meanPerceptualColorError: color.allBlocks.meanPerceptualError,
    shadowF1: shadow.masks.exact.f1,
    shadowCorrelation: shadow.pixels.shadowLossCorrelation,
    worstColorBlocks: color.worst.slice(0, 8),
    worstShadowPixels: shadow.worst.slice(0, 8),
  };
  const failures = [];
  minimum(failures, scene.id, "edge F1", metrics.edgeF1, scene.minimum.edgeF1);
  minimum(
    failures,
    scene.id,
    "tolerant edge F1",
    metrics.tolerantEdgeF1,
    scene.minimum.tolerantEdgeF1,
  );
  minimum(failures, scene.id, "shadow F1", metrics.shadowF1, scene.minimum.shadowF1);
  minimum(
    failures,
    scene.id,
    "shadow correlation",
    metrics.shadowCorrelation,
    scene.minimum.shadowCorrelation,
  );
  maximum(
    failures,
    scene.id,
    "mean perceptual color error",
    metrics.meanPerceptualColorError,
    scene.maximum.meanPerceptualColorError,
  );
  maximum(
    failures,
    scene.id,
    "alignment X",
    Math.abs(metrics.alignment.x),
    scene.maximum.alignmentPixels,
  );
  maximum(
    failures,
    scene.id,
    "alignment Z",
    Math.abs(metrics.alignment.y),
    scene.maximum.alignmentPixels,
  );
  return { id: scene.id, coordinates: { z: 2, x: scene.x, y: scene.y }, metrics, failures };
}

function minimum(failures, scene, metric, actual, expected) {
  if (actual < expected) failures.push(`${scene}: ${metric} ${actual} is below ${expected}`);
}

function maximum(failures, scene, metric, actual, expected) {
  if (actual > expected) failures.push(`${scene}: ${metric} ${actual} is above ${expected}`);
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Visual regression ${label} must be a positive integer, received ${raw}`);
  }
  return value;
}

function fixed(value) {
  return Number(value).toFixed(3);
}
