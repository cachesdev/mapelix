import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import jpeg from "jpeg-js";
import { PNG } from "pngjs";

const [
  candidateInput,
  referenceInput,
  heatmapOutput,
  pixelsPerBlockText = "4",
  tileXText,
  tileYText,
  reportOutput,
  surfaceInput,
] = process.argv.slice(2);

if (candidateInput === undefined || referenceInput === undefined) {
  throw new Error(
    "Usage: node scripts/measure-block-colors.mjs <candidate> <reference> [heatmap.png] [pixels-per-block] [tile-x] [tile-y] [report.json] [surface.json]",
  );
}

const pixelsPerBlock = positiveInteger(pixelsPerBlockText, "pixels per block");
const tileX = optionalInteger(tileXText, "tile x");
const tileY = optionalInteger(tileYText, "tile y");
const surface = surfaceInput === undefined ? undefined : JSON.parse(await readFile(surfaceInput));
const [candidate, reference] = await Promise.all([
  loadImage(candidateInput),
  loadImage(referenceInput),
]);
if (
  candidate.width !== reference.width ||
  candidate.height !== reference.height ||
  candidate.width % pixelsPerBlock !== 0 ||
  candidate.height % pixelsPerBlock !== 0
) {
  throw new RangeError("Images must have equal dimensions divisible by pixels per block");
}

const blocksWide = candidate.width / pixelsPerBlock;
const blocksHigh = candidate.height / pixelsPerBlock;
if (surface !== undefined && surface.sampleSize !== blocksWide) {
  throw new RangeError(
    `Surface sample size ${surface.sampleSize} does not match the ${blocksWide}-block image`,
  );
}
const cells = [];
const pairGroups = new Map();
for (let blockZ = 0; blockZ < blocksHigh; blockZ += 1) {
  for (let blockX = 0; blockX < blocksWide; blockX += 1) {
    const candidateCell = representativeColor(candidate, blockX, blockZ, pixelsPerBlock);
    const referenceCell = representativeColor(reference, blockX, blockZ, pixelsPerBlock);
    const ignored =
      candidateCell.alpha < 128 ||
      referenceCell.alpha < 128 ||
      isOracleBackground(referenceCell.rgb);
    const rgbError = ignored ? undefined : meanChannelError(candidateCell.rgb, referenceCell.rgb);
    const perceptualError =
      ignored || rgbError === undefined
        ? undefined
        : oklabDistance(candidateCell.rgb, referenceCell.rgb);
    const surfaceBlock = surface?.samples[blockZ * blocksWide + blockX] ?? undefined;
    const world =
      tileX === undefined || tileY === undefined
        ? undefined
        : {
            x: tileX * blocksWide + blockX,
            ...(surfaceBlock === undefined ? {} : { y: surfaceBlock.y }),
            z: tileY * blocksHigh + blockZ,
          };
    const cell = {
      block: { x: blockX, z: blockZ },
      ...(world === undefined ? {} : { world }),
      ...(surfaceBlock === undefined
        ? {}
        : {
            blockName: surfaceBlock.name,
            biomeId: surfaceBlock.biomeId,
            supportY: surfaceBlock.supportY,
          }),
      candidateRgb: candidateCell.rgb,
      referenceRgb: referenceCell.rgb,
      candidateSpread: candidateCell.spread,
      referenceSpread: referenceCell.spread,
      quiet: candidateCell.spread <= 12 && referenceCell.spread <= 12,
      ignored,
      rgbError,
      perceptualError,
    };
    cells.push(cell);
    if (!ignored && rgbError !== undefined && perceptualError !== undefined) {
      const candidateRgb = quantize(candidateCell.rgb);
      const referenceRgb = quantize(referenceCell.rgb);
      const key = `${candidateRgb.join(",")}→${referenceRgb.join(",")}`;
      const group = pairGroups.get(key) ?? {
        candidateRgb,
        referenceRgb,
        count: 0,
        totalRgbError: 0,
        totalPerceptualError: 0,
        blockNames: new Map(),
      };
      group.count += 1;
      group.totalRgbError += rgbError;
      group.totalPerceptualError += perceptualError;
      if (surfaceBlock?.name !== undefined) {
        group.blockNames.set(surfaceBlock.name, (group.blockNames.get(surfaceBlock.name) ?? 0) + 1);
      }
      pairGroups.set(key, group);
    }
  }
}

const valid = cells.filter((cell) => !cell.ignored);
const quiet = valid.filter((cell) => cell.quiet);
const worst = [...valid]
  .sort((left, right) => right.perceptualError - left.perceptualError)
  .slice(0, 24)
  .map(compactCell);
const systematicPairs = [...pairGroups.values()]
  .map((group) => ({
    candidateRgb: group.candidateRgb,
    referenceRgb: group.referenceRgb,
    count: group.count,
    meanRgbError: group.totalRgbError / group.count,
    meanPerceptualError: group.totalPerceptualError / group.count,
    impact: group.totalPerceptualError,
    blockNames: [...group.blockNames]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 8),
  }))
  .filter((group) => group.count >= 3 && group.meanPerceptualError >= 2)
  .sort((left, right) => right.impact - left.impact)
  .slice(0, 24);

const result = {
  candidate: candidateInput,
  reference: referenceInput,
  dimensions: { width: candidate.width, height: candidate.height },
  blockGrid: { pixelsPerBlock, blocksWide, blocksHigh },
  cells: { total: cells.length, compared: valid.length, quiet: quiet.length },
  allBlocks: summarize(valid),
  quietBlocks: summarize(quiet),
  worst,
  systematicPairs,
  heatmap: heatmapOutput,
  report: reportOutput,
  surface: surfaceInput,
};

if (heatmapOutput !== undefined) {
  const heatmap = new PNG({ width: candidate.width, height: candidate.height });
  for (const cell of cells) {
    const value = cell.ignored ? undefined : Math.min((cell.perceptualError ?? 0) / 25, 1);
    const color =
      value === undefined
        ? [96, 96, 96, 255]
        : [Math.round(255 * value), Math.round(255 * (1 - value)), 0, 255];
    fillBlock(heatmap, cell.block.x, cell.block.z, pixelsPerBlock, color);
  }
  await mkdir(dirname(heatmapOutput), { recursive: true });
  await writeFile(heatmapOutput, PNG.sync.write(heatmap));
}

const report = JSON.stringify(result, undefined, 2);
if (reportOutput !== undefined) {
  await mkdir(dirname(reportOutput), { recursive: true });
  await writeFile(reportOutput, `${report}\n`);
}
console.log(report);

function representativeColor(image, blockX, blockZ, scale) {
  const channels = [[], [], []];
  const alpha = [];
  const start = scale > 2 ? 1 : 0;
  for (let y = start; y < scale; y += 1) {
    for (let x = start; x < scale; x += 1) {
      const offset = ((blockZ * scale + y) * image.width + blockX * scale + x) * 4;
      channels[0].push(image.data[offset]);
      channels[1].push(image.data[offset + 1]);
      channels[2].push(image.data[offset + 2]);
      alpha.push(image.data[offset + 3]);
    }
  }
  const rgb = channels.map(median);
  const spread = Math.max(
    ...channels.map((channel, index) =>
      Math.max(...channel.map((value) => Math.abs(value - rgb[index]))),
    ),
  );
  return { rgb, alpha: median(alpha), spread };
}

function summarize(cellsToSummarize) {
  const rgb = cellsToSummarize.map((cell) => cell.rgbError).sort(numberOrder);
  const perceptual = cellsToSummarize.map((cell) => cell.perceptualError).sort(numberOrder);
  return {
    count: cellsToSummarize.length,
    meanRgbError: mean(rgb),
    meanPerceptualError: mean(perceptual),
    perceptualPercentiles: {
      p50: percentile(perceptual, 0.5),
      p90: percentile(perceptual, 0.9),
      p95: percentile(perceptual, 0.95),
      p99: percentile(perceptual, 0.99),
    },
    fractionWithinPerceptualError: {
      3: fractionAtMost(perceptual, 3),
      6: fractionAtMost(perceptual, 6),
      12: fractionAtMost(perceptual, 12),
    },
  };
}

function compactCell(cell) {
  return {
    block: cell.block,
    ...(cell.world === undefined ? {} : { world: cell.world }),
    ...(cell.blockName === undefined ? {} : { blockName: cell.blockName }),
    ...(cell.biomeId === undefined ? {} : { biomeId: cell.biomeId }),
    ...(cell.supportY === undefined ? {} : { supportY: cell.supportY }),
    candidateRgb: cell.candidateRgb,
    referenceRgb: cell.referenceRgb,
    rgbError: cell.rgbError,
    perceptualError: cell.perceptualError,
    quiet: cell.quiet,
  };
}

function quantize(rgb) {
  return rgb.map((channel) => Math.min(255, Math.round(channel / 8) * 8));
}

function isOracleBackground(rgb) {
  return Math.max(Math.abs(rgb[0] - 120), Math.abs(rgb[1] - 167), Math.abs(rgb[2] - 255)) <= 12;
}

function meanChannelError(left, right) {
  return (
    (Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2])) / 3
  );
}

function oklabDistance(left, right) {
  const a = toOklab(left);
  const b = toOklab(right);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100;
}

function toOklab(rgb) {
  const [red, green, blue] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fillBlock(image, blockX, blockZ, scale, color) {
  for (let y = 0; y < scale; y += 1) {
    for (let x = 0; x < scale; x += 1) {
      const offset = ((blockZ * scale + y) * image.width + blockX * scale + x) * 4;
      image.data.set(color, offset);
    }
  }
}

async function loadImage(input) {
  const bytes = await readFile(input);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return PNG.sync.read(bytes);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return jpeg.decode(bytes, { formatAsRGBA: true, useTArray: true });
  }
  throw new TypeError(`${input} is not a PNG or JPEG image`);
}

function median(values) {
  const sorted = [...values].sort(numberOrder);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values) {
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, fraction) {
  if (values.length === 0) return undefined;
  return values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
}

function fractionAtMost(values, limit) {
  return values.length === 0
    ? undefined
    : values.filter((value) => value <= limit).length / values.length;
}

function numberOrder(left, right) {
  return left - right;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new RangeError(`${name} must be positive`);
  return parsed;
}

function optionalInteger(value, name) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RangeError(`${name} must be an integer`);
  return parsed;
}
