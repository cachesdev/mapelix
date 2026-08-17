import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PNG } from "pngjs";

const [
  candidateInput,
  candidateShadowlessInput,
  referenceInput,
  referenceShadowlessInput,
  overlayOutput,
  pixelsPerBlockText = "4",
  tileXText,
  tileYText,
  reportOutput,
  surfaceInput,
] = process.argv.slice(2);

if (
  candidateInput === undefined ||
  candidateShadowlessInput === undefined ||
  referenceInput === undefined ||
  referenceShadowlessInput === undefined
) {
  throw new Error(
    "Usage: node scripts/measure-shadows.mjs <candidate.png> <candidate-shadowless.png> <reference.png> <reference-shadowless.png> [overlay.png] [pixels-per-block] [tile-x] [tile-y] [report.json] [surface.json]",
  );
}

const pixelsPerBlock = positiveInteger(pixelsPerBlockText, "pixels per block");
const tileX = optionalInteger(tileXText, "tile x");
const tileY = optionalInteger(tileYText, "tile y");
const surface = surfaceInput === undefined ? undefined : JSON.parse(await readFile(surfaceInput));
const images = await Promise.all(
  [candidateInput, candidateShadowlessInput, referenceInput, referenceShadowlessInput].map(loadPng),
);
const [candidate, candidateShadowless, reference, referenceShadowless] = images;
const { width, height } = candidate;
if (images.some((image) => image.width !== width || image.height !== height)) {
  throw new RangeError("All shadow comparison images must have equal dimensions");
}
if (width % pixelsPerBlock !== 0 || height % pixelsPerBlock !== 0) {
  throw new RangeError("Image dimensions must be divisible by pixels per block");
}

const candidateLoss = shadowLossField(candidate, candidateShadowless);
const referenceLoss = shadowLossField(reference, referenceShadowless);
const threshold = 0.05;
const candidateMask = thresholdField(candidateLoss, threshold);
const referenceMask = thresholdField(referenceLoss, threshold);
const exact = compareMasks(candidateMask, referenceMask, width, height, 0);
const tolerant = compareMasks(candidateMask, referenceMask, width, height, 1);
const valid = [];
for (let pixel = 0; pixel < candidateLoss.length; pixel += 1) {
  if (!Number.isFinite(candidateLoss[pixel]) || !Number.isFinite(referenceLoss[pixel])) continue;
  const x = pixel % width;
  const z = Math.floor(pixel / width);
  const blockX = Math.floor(x / pixelsPerBlock);
  const blockZ = Math.floor(z / pixelsPerBlock);
  const surfaceBlock = surface?.samples[blockZ * (width / pixelsPerBlock) + blockX];
  valid.push({
    pixel: { x, z },
    subpixel: { x: x % pixelsPerBlock, z: z % pixelsPerBlock },
    ...(tileX === undefined || tileY === undefined
      ? {}
      : {
          world: {
            x: tileX * (width / pixelsPerBlock) + blockX,
            ...(surfaceBlock?.y === undefined ? {} : { y: surfaceBlock.y }),
            z: tileY * (height / pixelsPerBlock) + blockZ,
          },
        }),
    ...(surfaceBlock?.name === undefined ? {} : { blockName: surfaceBlock.name }),
    candidateLoss: candidateLoss[pixel],
    referenceLoss: referenceLoss[pixel],
    absoluteError: Math.abs(candidateLoss[pixel] - referenceLoss[pixel]),
  });
}

const result = {
  candidate: { normal: candidateInput, shadowless: candidateShadowlessInput },
  reference: { normal: referenceInput, shadowless: referenceShadowlessInput },
  dimensions: { width, height },
  pixelsPerBlock,
  threshold,
  pixels: {
    compared: valid.length,
    meanAbsoluteShadowLossError: mean(valid.map((sample) => sample.absoluteError)),
    shadowLossCorrelation: correlation(
      valid.map((sample) => sample.candidateLoss),
      valid.map((sample) => sample.referenceLoss),
    ),
    candidateMeanShadowLoss: mean(valid.map((sample) => sample.candidateLoss)),
    referenceMeanShadowLoss: mean(valid.map((sample) => sample.referenceLoss)),
  },
  masks: { exact, withinOnePixel: tolerant },
  worst: [...valid].sort((left, right) => right.absoluteError - left.absoluteError).slice(0, 32),
  overlay: overlayOutput,
  report: reportOutput,
  surface: surfaceInput,
};

if (overlayOutput !== undefined) {
  const overlay = new PNG({ width, height });
  for (let pixel = 0; pixel < candidateMask.length; pixel += 1) {
    const offset = pixel * 4;
    const candidateShadow = candidateMask[pixel] === 1;
    const referenceShadow = referenceMask[pixel] === 1;
    overlay.data[offset] = referenceShadow ? 255 : 0;
    overlay.data[offset + 1] = candidateShadow && referenceShadow ? 255 : 0;
    overlay.data[offset + 2] = candidateShadow ? 255 : 0;
    overlay.data[offset + 3] = candidateShadow || referenceShadow ? 255 : 48;
  }
  await mkdir(dirname(overlayOutput), { recursive: true });
  await writeFile(overlayOutput, PNG.sync.write(overlay));
}

const report = JSON.stringify(result, undefined, 2);
if (reportOutput !== undefined) {
  await mkdir(dirname(reportOutput), { recursive: true });
  await writeFile(reportOutput, `${report}\n`);
}
console.log(report);

async function loadPng(path) {
  const bytes = await readFile(path);
  if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new TypeError(`${path} is not a lossless PNG`);
  }
  return PNG.sync.read(bytes);
}

function shadowLossField(normal, shadowless) {
  const result = new Float32Array(normal.width * normal.height);
  for (let pixel = 0; pixel < result.length; pixel += 1) {
    const offset = pixel * 4;
    if (normal.data[offset + 3] < 128 || shadowless.data[offset + 3] < 128) {
      result[pixel] = Number.NaN;
      continue;
    }
    const base = luminance(shadowless.data, offset);
    result[pixel] =
      base < 8 ? Number.NaN : Math.max(0, Math.min(1, 1 - luminance(normal.data, offset) / base));
  }
  return result;
}

function luminance(data, offset) {
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
}

function thresholdField(values, threshold) {
  const result = new Uint8Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    result[index] = Number.isFinite(values[index]) && values[index] >= threshold ? 1 : 0;
  }
  return result;
}

function compareMasks(candidate, reference, width, height, tolerance) {
  let candidateCount = 0;
  let referenceCount = 0;
  let matchedCandidate = 0;
  let matchedReference = 0;
  for (let z = 0; z < height; z += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = z * width + x;
      if (candidate[pixel] === 1) {
        candidateCount += 1;
        if (hasMask(reference, width, height, x, z, tolerance)) matchedCandidate += 1;
      }
      if (reference[pixel] === 1) {
        referenceCount += 1;
        if (hasMask(candidate, width, height, x, z, tolerance)) matchedReference += 1;
      }
    }
  }
  const precision = candidateCount === 0 ? 1 : matchedCandidate / candidateCount;
  const recall = referenceCount === 0 ? 1 : matchedReference / referenceCount;
  return {
    candidateFraction: candidateCount / candidate.length,
    referenceFraction: referenceCount / reference.length,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function hasMask(mask, width, height, x, z, tolerance) {
  for (let dz = -tolerance; dz <= tolerance; dz += 1) {
    for (let dx = -tolerance; dx <= tolerance; dx += 1) {
      const candidateX = x + dx;
      const candidateZ = z + dz;
      if (
        candidateX >= 0 &&
        candidateX < width &&
        candidateZ >= 0 &&
        candidateZ < height &&
        mask[candidateZ * width + candidateX] === 1
      ) {
        return true;
      }
    }
  }
  return false;
}

function correlation(left, right) {
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDifference = left[index] - leftMean;
    const rightDifference = right[index] - rightMean;
    covariance += leftDifference * rightDifference;
    leftVariance += leftDifference * leftDifference;
    rightVariance += rightDifference * rightDifference;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? 0 : covariance / denominator;
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function positiveInteger(raw, label) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer, received ${raw}`);
  }
  return value;
}

function optionalInteger(raw, label) {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer`);
  return value;
}
