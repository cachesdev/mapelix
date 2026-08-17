import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const [candidateInput, referenceInput, overlayOutput, pixelsPerBlockText = "4"] =
  process.argv.slice(2);

if (candidateInput === undefined || referenceInput === undefined) {
  throw new Error(
    "Usage: node scripts/compare-renderers.mjs <candidate.png> <reference.png-or-jpeg> [edge-overlay.png] [pixels-per-block]",
  );
}

const pixelsPerBlock = parsePositiveInteger(pixelsPerBlockText, "pixels per block");
const [candidate, reference] = await Promise.all([
  loadImage(candidateInput),
  loadImage(referenceInput),
]);
if (candidate.width !== reference.width || candidate.height !== reference.height) {
  throw new RangeError(
    `Image dimensions differ: candidate is ${candidate.width}x${candidate.height}, reference is ${reference.width}x${reference.height}`,
  );
}
if (candidate.width % pixelsPerBlock !== 0 || candidate.height % pixelsPerBlock !== 0) {
  throw new RangeError("Image dimensions must be divisible by pixels per block");
}

const candidateLuminance = luminanceField(candidate);
const referenceLuminance = luminanceField(reference);
const candidateEdges = sobelField(candidateLuminance, candidate.width, candidate.height);
const referenceEdges = sobelField(referenceLuminance, reference.width, reference.height);
const strongEdgeThreshold = 80;
const candidateStrong = thresholdEdges(candidateEdges.magnitude, strongEdgeThreshold);
const referenceStrong = thresholdEdges(referenceEdges.magnitude, strongEdgeThreshold);
const alignment = findBestAlignment(
  candidateStrong,
  referenceStrong,
  candidate.width,
  candidate.height,
  4,
);
const exactEdges = compareEdges(
  candidateStrong,
  referenceStrong,
  candidate.width,
  candidate.height,
  0,
  0,
  0,
);
const tolerantEdges = compareEdges(
  candidateStrong,
  referenceStrong,
  candidate.width,
  candidate.height,
  alignment.x,
  alignment.y,
  1,
);

const result = {
  candidate: candidateInput,
  reference: referenceInput,
  dimensions: { width: candidate.width, height: candidate.height },
  pixelsPerBlock,
  edgeThreshold: strongEdgeThreshold,
  edgeEnergy: {
    candidateMeanSobel: mean(candidateEdges.magnitude),
    referenceMeanSobel: mean(referenceEdges.magnitude),
    candidateStrongFraction: fractionTrue(candidateStrong),
    referenceStrongFraction: fractionTrue(referenceStrong),
  },
  color: compareColor(candidate, reference, candidateLuminance, referenceLuminance),
  alignment: {
    bestOffsetPixels: alignment,
    exact: exactEdges,
    withinOnePixelAtBestOffset: tolerantEdges,
  },
  blockGrid: {
    candidate: blockGridContrast(
      candidateLuminance,
      candidate.width,
      candidate.height,
      pixelsPerBlock,
    ),
    reference: blockGridContrast(
      referenceLuminance,
      reference.width,
      reference.height,
      pixelsPerBlock,
    ),
  },
  withinBlockLuminanceDeviation: {
    candidate: meanBlockDeviation(
      candidateLuminance,
      candidate.width,
      candidate.height,
      pixelsPerBlock,
    ),
    reference: meanBlockDeviation(
      referenceLuminance,
      reference.width,
      reference.height,
      pixelsPerBlock,
    ),
  },
  overlay: overlayOutput,
};

if (overlayOutput !== undefined) {
  const overlay = makeEdgeOverlay(
    candidateLuminance,
    candidateStrong,
    referenceStrong,
    candidate.width,
    candidate.height,
    alignment.x,
    alignment.y,
  );
  await mkdir(dirname(overlayOutput), { recursive: true });
  await writeFile(overlayOutput, PNG.sync.write(overlay));
}

console.log(JSON.stringify(result, undefined, 2));

async function loadImage(input) {
  const bytes = await loadBytes(input);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return PNG.sync.read(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpeg.decode(bytes, { formatAsRGBA: true, useTArray: true });
  }
  throw new TypeError(`${input} is not a PNG or JPEG image`);
}

async function loadBytes(input) {
  if (!/^https?:\/\//.test(input)) return readFile(input);
  const response = await fetch(input);
  if (!response.ok) throw new Error(`${input} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function luminanceField(image) {
  const result = new Float32Array(image.width * image.height);
  for (let pixel = 0; pixel < result.length; pixel += 1) {
    const offset = pixel * 4;
    result[pixel] =
      image.data[offset] * 0.2126 +
      image.data[offset + 1] * 0.7152 +
      image.data[offset + 2] * 0.0722;
  }
  return result;
}

function compareColor(candidate, reference, candidateLuminance, referenceLuminance) {
  const candidateChannels = [0, 0, 0];
  const referenceChannels = [0, 0, 0];
  let absoluteChannelDelta = 0;
  let absoluteLuminanceDelta = 0;
  for (let pixel = 0; pixel < candidateLuminance.length; pixel += 1) {
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      const candidateValue = candidate.data[offset + channel];
      const referenceValue = reference.data[offset + channel];
      candidateChannels[channel] += candidateValue;
      referenceChannels[channel] += referenceValue;
      absoluteChannelDelta += Math.abs(candidateValue - referenceValue);
    }
    absoluteLuminanceDelta += Math.abs(candidateLuminance[pixel] - referenceLuminance[pixel]);
  }
  return {
    candidateMeanRgb: candidateChannels.map((channel) => channel / candidateLuminance.length),
    referenceMeanRgb: referenceChannels.map((channel) => channel / referenceLuminance.length),
    meanAbsoluteChannelDelta: absoluteChannelDelta / (candidateLuminance.length * 3),
    meanAbsoluteLuminanceDelta: absoluteLuminanceDelta / candidateLuminance.length,
    luminanceCorrelation: correlation(candidateLuminance, referenceLuminance),
  };
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

function sobelField(luminance, width, height) {
  const magnitude = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = luminance[(y - 1) * width + x - 1];
      const top = luminance[(y - 1) * width + x];
      const topRight = luminance[(y - 1) * width + x + 1];
      const left = luminance[y * width + x - 1];
      const right = luminance[y * width + x + 1];
      const bottomLeft = luminance[(y + 1) * width + x - 1];
      const bottom = luminance[(y + 1) * width + x];
      const bottomRight = luminance[(y + 1) * width + x + 1];
      const gradientX = -topLeft - 2 * left - bottomLeft + topRight + 2 * right + bottomRight;
      const gradientY = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      magnitude[y * width + x] = Math.hypot(gradientX, gradientY);
    }
  }
  return { magnitude };
}

function thresholdEdges(magnitude, threshold) {
  const result = new Uint8Array(magnitude.length);
  for (let index = 0; index < magnitude.length; index += 1) {
    result[index] = magnitude[index] >= threshold ? 1 : 0;
  }
  return result;
}

function findBestAlignment(candidate, reference, width, height, radius) {
  let best = { x: 0, y: 0, overlap: -1 };
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const overlap = compareEdges(candidate, reference, width, height, x, y, 0).overlap;
      if (overlap > best.overlap) best = { x, y, overlap };
    }
  }
  return best;
}

function compareEdges(candidate, reference, width, height, offsetX, offsetY, tolerance) {
  let candidateCount = 0;
  let referenceCount = 0;
  let matchedCandidate = 0;
  let matchedReference = 0;
  let overlap = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const candidateEdge = candidate[y * width + x] === 1;
      const referenceX = x + offsetX;
      const referenceY = y + offsetY;
      const referenceEdge = edgeAt(reference, width, height, referenceX, referenceY);
      if (candidateEdge) {
        candidateCount += 1;
        if (hasEdge(reference, width, height, referenceX, referenceY, tolerance)) {
          matchedCandidate += 1;
        }
      }
      if (referenceEdge) {
        referenceCount += 1;
        if (hasEdge(candidate, width, height, x, y, tolerance)) matchedReference += 1;
      }
      if (candidateEdge && referenceEdge) overlap += 1;
    }
  }
  const precision = divide(matchedCandidate, candidateCount);
  const recall = divide(matchedReference, referenceCount);
  return {
    overlap,
    candidateCount,
    referenceCount,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

function edgeAt(edges, width, height, x, y) {
  return x >= 0 && y >= 0 && x < width && y < height && edges[y * width + x] === 1;
}

function hasEdge(edges, width, height, x, y, radius) {
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      if (edgeAt(edges, width, height, x + offsetX, y + offsetY)) return true;
    }
  }
  return false;
}

function blockGridContrast(luminance, width, height, blockSize) {
  let boundaryDelta = 0;
  let boundaryCount = 0;
  let interiorDelta = 0;
  let interiorCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x > 0) addDelta(x, y, x - 1, y, x % blockSize === 0);
      if (y > 0) addDelta(x, y, x, y - 1, y % blockSize === 0);
    }
  }
  const boundary = divide(boundaryDelta, boundaryCount);
  const interior = divide(interiorDelta, interiorCount);
  return { boundaryDelta: boundary, interiorDelta: interior, ratio: divide(boundary, interior) };

  function addDelta(x1, y1, x2, y2, boundary) {
    const delta = Math.abs(luminance[y1 * width + x1] - luminance[y2 * width + x2]);
    if (boundary) {
      boundaryDelta += delta;
      boundaryCount += 1;
    } else {
      interiorDelta += delta;
      interiorCount += 1;
    }
  }
}

function meanBlockDeviation(luminance, width, height, blockSize) {
  let total = 0;
  let count = 0;
  for (let blockY = 0; blockY < height; blockY += blockSize) {
    for (let blockX = 0; blockX < width; blockX += blockSize) {
      let blockMean = 0;
      for (let y = blockY; y < blockY + blockSize; y += 1) {
        for (let x = blockX; x < blockX + blockSize; x += 1) {
          blockMean += luminance[y * width + x];
        }
      }
      blockMean /= blockSize * blockSize;
      let squaredDeviation = 0;
      for (let y = blockY; y < blockY + blockSize; y += 1) {
        for (let x = blockX; x < blockX + blockSize; x += 1) {
          const difference = luminance[y * width + x] - blockMean;
          squaredDeviation += difference * difference;
        }
      }
      total += Math.sqrt(squaredDeviation / (blockSize * blockSize));
      count += 1;
    }
  }
  return divide(total, count);
}

function makeEdgeOverlay(luminance, candidate, reference, width, height, offsetX, offsetY) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const offset = index * 4;
      const candidateEdge = candidate[index] === 1;
      const referenceEdge = edgeAt(reference, width, height, x + offsetX, y + offsetY);
      const backdrop = Math.round(luminance[index] * 0.18);
      png.data[offset] = referenceEdge ? 255 : candidateEdge ? 0 : backdrop;
      png.data[offset + 1] = candidateEdge ? 255 : referenceEdge ? 0 : backdrop;
      png.data[offset + 2] = candidateEdge ? 255 : 0;
      png.data[offset + 3] = 255;
    }
  }
  return png;
}

function fractionTrue(values) {
  let count = 0;
  for (const value of values) count += value;
  return divide(count, values.length);
}

function mean(values) {
  let total = 0;
  for (const value of values) total += value;
  return divide(total, values.length);
}

function divide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new TypeError(`Invalid ${label}: ${value}`);
  return parsed;
}
