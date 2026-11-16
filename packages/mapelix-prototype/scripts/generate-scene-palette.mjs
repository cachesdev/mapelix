import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";

class UnsupportedTexture extends Error {}

const [samplesDirectory, outputArgument, reportArgument] = process.argv.slice(2);
if (samplesDirectory === undefined) {
  throw new Error(
    "Usage: node scripts/generate-scene-palette.mjs <extracted-bedrock-samples> [output.ts] [coverage.json]",
  );
}

const manifest = await json(new URL("./scene-palette-sources.json", import.meta.url));
const blocks = await json(resolve(samplesDirectory, "resource_pack/blocks.json"));
const terrain = await json(
  resolve(samplesDirectory, "resource_pack/textures/terrain_texture.json"),
);
const metadata = await json(
  resolve(samplesDirectory, "metadata/vanilladata_modules/mojang-blocks.json"),
);
const knownBlocks = new Set(metadata.data_items.map((item) => item.name));
const images = new Map();
const fingerprints = new Map();
const palette = new Map();
const colorStates = new Map();
const unresolved = [];

for (const name of [...knownBlocks].sort(compare)) {
  const block = name.replace(/^minecraft:/, "");
  if (manifest.exclusions[block] !== undefined) {
    unresolved.push({ block, reason: manifest.exclusions[block] });
    continue;
  }
  const override = manifest.overrides[block] ?? {};
  const textures = override.textures ?? blocks[block]?.textures;
  try {
    if (textures === undefined) throw new UnsupportedTexture("No resource texture binding");
    const colors = await faces(textures, 0);
    const variants = [];
    for (const variant of override.variants ?? []) {
      const bindings = variant.textures ?? textures;
      const variantTextures =
        variant.path === undefined
          ? bindings
          : Object.fromEntries(
              Object.entries(bindings).map(([face, binding]) => [
                face,
                typeof binding === "object" && binding.path !== undefined
                  ? { ...binding, path: variant.path }
                  : binding,
              ]),
            );
      variants.push({
        states: variant.states,
        colors: await faces(variantTextures, variant.textureIndex ?? 0),
      });
    }
    palette.set(block, { colors, variants });
    if (variants.length > 0) {
      colorStates.set(
        block,
        [...new Set(variants.flatMap((v) => Object.keys(v.states)))].sort(compare),
      );
    }
  } catch (error) {
    if (!(error instanceof UnsupportedTexture)) throw error;
    unresolved.push({ block, reason: error.message });
  }
}

const fingerprint = createHash("sha256").update(
  JSON.stringify({ manifest, blocks, terrain, metadata }),
);
for (const [path, hash] of [...fingerprints].sort(([a], [b]) => compare(a, b))) {
  fingerprint.update(`${path}\0${hash}\n`);
}
const lines = [
  `// Generated from Mojang Bedrock samples ${manifest.source.version}; do not edit by hand.`,
  "// Source bindings: ../mapelix-prototype/scripts/scene-palette-sources.json (from the package root).",
  `// Inputs SHA-256: ${fingerprint.digest("hex")}`,
  "// Alpha-weighted sRGB texture means; lateral faces receive equal weight. No texture assets included.",
  "",
  "export type BlockFaceColors = readonly [top: number, side: number, bottom: number];",
  "export interface SampledBlockColors {",
  "  readonly colors: BlockFaceColors;",
  "  readonly variants?: readonly {",
  "    readonly states: Readonly<Record<string, string | number>>;",
  "    readonly colors: BlockFaceColors;",
  "  }[];",
  "}",
  "",
  "export const BEDROCK_BLOCK_COLORS: Readonly<Record<string, SampledBlockColors>> = {",
];
for (const [block, entry] of palette) {
  const variants =
    entry.variants.length === 0
      ? ""
      : `, variants: [${entry.variants.map((v) => `{ states: ${JSON.stringify(v.states)}, colors: ${literal(v.colors)} }`).join(", ")}]`;
  lines.push(`  ${block}: { colors: ${literal(entry.colors)}${variants} },`);
}
lines.push(
  "};",
  "",
  "export const BEDROCK_COLOR_STATES: Readonly<Record<string, readonly string[]>> = {",
);
for (const [block, keys] of colorStates) lines.push(`  ${block}: ${JSON.stringify(keys)},`);
lines.push("};", "");
lines.push(
  "export const BEDROCK_BLOCK_IDS: readonly string[] = " +
    JSON.stringify([...knownBlocks].map((name) => name.replace(/^minecraft:/, "")).sort(compare)) +
    ";",
  "",
);
const output =
  outputArgument === undefined
    ? fileURLToPath(new URL("../../mapelix-core/src/appearance/bedrock-colors.ts", import.meta.url))
    : resolve(outputArgument);
await writeFile(output, lines.join("\n"));
if (reportArgument !== undefined) {
  await writeFile(
    resolve(reportArgument),
    JSON.stringify(
      {
        version: manifest.source.version,
        total: knownBlocks.size,
        sampled: palette.size,
        unresolved,
      },
      null,
      2,
    ) + "\n",
  );
}
console.log(
  `Wrote ${palette.size}/${knownBlocks.size} block palettes from ${images.size} textures; ${unresolved.length} unresolved`,
);

async function json(path) {
  // Mojang's terrain catalog has a leading line comment.
  return JSON.parse((await readFile(path, "utf8")).replace(/^\s*\/\/.*$/gm, ""));
}

async function faces(textures, index) {
  if (typeof textures === "string" || Array.isArray(textures)) {
    const color = await textureMean(textures, index);
    return [color, color, color];
  }
  const side = textures.side;
  const laterals =
    side === undefined
      ? ["north", "south", "east", "west"].map((face) => {
          if (textures[face] === undefined) throw new UnsupportedTexture(`Missing ${face} face`);
          return textures[face];
        })
      : [side];
  const top = await textureMean(textures.up ?? side, index);
  const sides = [];
  // Fixed traversal also makes missing-texture reports and input fingerprints reproducible.
  for (const key of laterals) sides.push(unpack(await textureMean(key, index)));
  return [top, pack(average(sides)), await textureMean(textures.down ?? side, index)];
}

async function textureMean(keys, index) {
  const names = Array.isArray(keys) ? keys : [keys];
  const colors = [];
  for (const binding of names) {
    const key = typeof binding === "string" ? binding : binding.key;
    const selectedIndex = typeof binding === "string" ? index : binding.index;
    const definition =
      typeof binding === "object" && binding.path !== undefined
        ? binding.path
        : terrain.texture_data[key]?.textures;
    let path = Array.isArray(definition) ? definition[selectedIndex] : definition;
    if (typeof path === "object" && path !== null) path = path.path;
    if (typeof path !== "string")
      throw new UnsupportedTexture(`Unsupported texture ${key} at index ${selectedIndex}`);
    const regions = typeof binding === "object" ? binding.regions : undefined;
    const sampleKey = regions === undefined ? path : `${path}|${JSON.stringify(regions)}`;
    let color = images.get(sampleKey);
    if (color === undefined) {
      let bytes;
      try {
        bytes = await readFile(resolve(samplesDirectory, "resource_pack", `${path}.png`));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        try {
          bytes = await readFile(resolve(samplesDirectory, "resource_pack", `${path}.tga`));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          throw new UnsupportedTexture(`Texture unavailable (PNG/TGA): ${path}`);
        }
      }
      fingerprints.set(path, createHash("sha256").update(bytes).digest("hex"));
      const { data, width, height } = bytes[0] === 137 ? PNG.sync.read(bytes) : readTga(bytes);
      const total = [0, 0, 0];
      let weight = 0;
      for (const [x, y, w, h] of regions ?? [[0, 0, width, height]]) {
        if (
          ![x, y, w, h].every(Number.isInteger) ||
          x < 0 ||
          y < 0 ||
          w <= 0 ||
          h <= 0 ||
          x + w > width ||
          y + h > height
        ) {
          throw new UnsupportedTexture(`Invalid sample rectangle: ${path}`);
        }
        for (let row = y; row < y + h; row++) {
          for (let column = x; column < x + w; column++) {
            const pixel = (row * width + column) * 4;
            const alpha = data[pixel + 3];
            weight += alpha;
            for (let channel = 0; channel < 3; channel++)
              total[channel] += data[pixel + channel] * alpha;
          }
        }
      }
      if (weight === 0) throw new UnsupportedTexture(`Fully transparent texture: ${path}`);
      color = total.map((sum) => sum / weight);
      images.set(sampleKey, color);
    }
    colors.push(color);
  }
  return pack(average(colors));
}

function average(colors) {
  return [0, 1, 2].map((channel) => colors.reduce((sum, c) => sum + c[channel], 0) / colors.length);
}

function pack(color) {
  return (Math.round(color[0]) << 16) | (Math.round(color[1]) << 8) | Math.round(color[2]);
}

function unpack(color) {
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255];
}

function literal(colors) {
  return `[${colors.map((color) => `0x${color.toString(16).padStart(6, "0")}`).join(", ")}]`;
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True-color TGA, including RLE, decoded only by this offline generation tool. */
function readTga(bytes) {
  if (bytes.length < 18) throw new UnsupportedTexture("Truncated TGA header");
  const type = bytes[2];
  const width = bytes.readUInt16LE(12);
  const height = bytes.readUInt16LE(14);
  const channels = bytes[16] / 8;
  if (
    bytes[1] !== 0 ||
    (type !== 2 && type !== 10) ||
    (channels !== 3 && channels !== 4) ||
    width === 0 ||
    height === 0 ||
    width * height > 16_777_216
  ) {
    throw new UnsupportedTexture("Unsupported TGA layout");
  }
  const data = new Uint8Array(width * height * 4);
  const descriptor = bytes[17];
  let offset = 18 + bytes[0];
  let written = 0;
  const pixel = () => {
    if (offset + channels > bytes.length) throw new UnsupportedTexture("Truncated TGA pixels");
    const rgba = [
      bytes[offset + 2],
      bytes[offset + 1],
      bytes[offset],
      channels === 4 && (descriptor & 15) !== 0 ? bytes[offset + 3] : 255,
    ];
    offset += channels;
    return rgba;
  };
  while (written < width * height) {
    if (offset >= bytes.length) throw new UnsupportedTexture("Truncated TGA pixels");
    const packet = type === 10 ? bytes[offset++] : 0;
    const count = (packet & 127) + 1;
    if (written + count > width * height) throw new UnsupportedTexture("Invalid TGA run length");
    const repeated = (packet & 128) !== 0 ? pixel() : undefined;
    for (let i = 0; i < count; i++) {
      const rgba = repeated ?? pixel();
      const x = (descriptor & 16) !== 0 ? width - 1 - (written % width) : written % width;
      const y =
        (descriptor & 32) !== 0
          ? Math.floor(written / width)
          : height - 1 - Math.floor(written / width);
      data.set(rgba, (y * width + x) * 4);
      written++;
    }
  }
  return { data, width, height };
}
