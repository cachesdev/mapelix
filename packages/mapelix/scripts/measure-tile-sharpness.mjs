import { readFile } from "node:fs/promises";

import { PNG } from "pngjs";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  throw new Error("Usage: node scripts/measure-tile-sharpness.mjs <file-or-url> [...]");
}

const results = [];
for (const input of inputs) {
  const bytes = await loadBytes(input);
  const png = PNG.sync.read(bytes);
  let sobel = 0;
  let laplacian = 0;
  let strongEdges = 0;
  let count = 0;

  for (let z = 1; z < png.height - 1; z += 1) {
    for (let x = 1; x < png.width - 1; x += 1) {
      const gradientX =
        -luminance(png, x - 1, z - 1) -
        2 * luminance(png, x - 1, z) -
        luminance(png, x - 1, z + 1) +
        luminance(png, x + 1, z - 1) +
        2 * luminance(png, x + 1, z) +
        luminance(png, x + 1, z + 1);
      const gradientZ =
        -luminance(png, x - 1, z - 1) -
        2 * luminance(png, x, z - 1) -
        luminance(png, x + 1, z - 1) +
        luminance(png, x - 1, z + 1) +
        2 * luminance(png, x, z + 1) +
        luminance(png, x + 1, z + 1);
      const gradient = Math.hypot(gradientX, gradientZ);
      sobel += gradient;
      laplacian += Math.abs(
        4 * luminance(png, x, z) -
          luminance(png, x - 1, z) -
          luminance(png, x + 1, z) -
          luminance(png, x, z - 1) -
          luminance(png, x, z + 1),
      );
      if (gradient > 80) strongEdges += 1;
      count += 1;
    }
  }

  results.push({
    input,
    pngBytes: bytes.byteLength,
    meanSobel: sobel / count,
    meanAbsoluteLaplacian: laplacian / count,
    strongEdgeFraction: strongEdges / count,
  });
}

console.log(JSON.stringify(results, undefined, 2));

async function loadBytes(input) {
  if (!/^https?:\/\//.test(input)) return readFile(input);
  const response = await fetch(input);
  if (!response.ok) throw new Error(`${input} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function luminance(png, x, z) {
  const offset = (z * png.width + x) * 4;
  return png.data[offset] * 0.2126 + png.data[offset + 1] * 0.7152 + png.data[offset + 2] * 0.0722;
}
