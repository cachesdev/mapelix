import { PNG } from "pngjs";

const [url, blockSizeText = "8", cropXText = "0", cropZText = "0", cropSizeText = "256"] =
  process.argv.slice(2);

if (url === undefined) {
  throw new Error(
    "Usage: node scripts/measure-tile-grid.mjs <tile-url> [block-size] [crop-x] [crop-z] [crop-size]",
  );
}

const blockSize = parseInteger(blockSizeText, "block size");
const cropX = parseInteger(cropXText, "crop x");
const cropZ = parseInteger(cropZText, "crop z");
const cropSize = parseInteger(cropSizeText, "crop size");
const response = await fetch(url);
if (!response.ok) throw new Error(`Tile request failed with HTTP ${response.status}`);
const png = PNG.sync.read(Buffer.from(await response.arrayBuffer()));

if (cropX < 0 || cropZ < 0 || cropX + cropSize > png.width || cropZ + cropSize > png.height) {
  throw new RangeError("Crop is outside the tile");
}

let boundaryDelta = 0;
let boundaryCount = 0;
let interiorDelta = 0;
let interiorCount = 0;

for (let z = cropZ; z < cropZ + cropSize; z += 1) {
  for (let x = cropX; x < cropX + cropSize; x += 1) {
    if (x > cropX) addDelta(x, z, x - 1, z, x % blockSize === 0);
    if (z > cropZ) addDelta(x, z, x, z - 1, z % blockSize === 0);
  }
}

const boundary = boundaryDelta / boundaryCount;
const interior = interiorDelta / interiorCount;
const ratio = interior === 0 ? (boundary === 0 ? 0 : Number.MAX_VALUE) : boundary / interior;
const result = {
  url,
  blockSize,
  crop: { x: cropX, z: cropZ, size: cropSize },
  boundaryLuminanceDelta: boundary,
  interiorLuminanceDelta: interior,
  gridRatio: ratio,
  maximumAcceptedRatio: 1.5,
};

console.log(JSON.stringify(result, undefined, 2));
if (ratio >= result.maximumAcceptedRatio) {
  console.error("FAIL: periodic block-boundary contrast is visible");
  process.exitCode = 1;
}

function addDelta(x1, z1, x2, z2, boundary) {
  const delta = Math.abs(luminance(x1, z1) - luminance(x2, z2));
  if (boundary) {
    boundaryDelta += delta;
    boundaryCount += 1;
  } else {
    interiorDelta += delta;
    interiorCount += 1;
  }
}

function luminance(x, z) {
  const offset = (z * png.width + x) * 4;
  return png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
}

function parseInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new TypeError(`Invalid ${label}: ${value}`);
  return parsed;
}
