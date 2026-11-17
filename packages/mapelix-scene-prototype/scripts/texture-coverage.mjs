// Reports which block appearances a resource pack stack textures.
// Usage: node scripts/texture-coverage.mjs <pack> [<pack> ...]   (highest priority first)
// Build first. It reads the packs only and prints counts and the blocks left with colors.
import { resolveBlockAppearance } from "../dist/blocks/block-appearance.js";
import { BEDROCK_BLOCK_COLORS } from "../dist/blocks/bedrock-colors.js";
import { openResourcePackStack, resolveBlockTextures } from "../dist/textures/index.js";

const sources = process.argv.slice(2);
if (sources.length === 0) throw new Error("Usage: texture-coverage.mjs <pack> [<pack> ...]");
const stack = await openResourcePackStack(sources);
console.log(
  `Stack ${stack.fingerprint}:`,
  stack.packs.map((pack) => pack.info),
);

// The same requests as the appearance parity check: every block, its listed variants and axes.
const requests = [];
for (const name of Object.keys(BEDROCK_BLOCK_COLORS).sort()) {
  const variants = BEDROCK_BLOCK_COLORS[name]?.variants?.map((row) => row.states) ?? [];
  for (const states of [{}, ...variants, { pillar_axis: "x" }, { pillar_axis: "z" }]) {
    requests.push({ name: `minecraft:${name}`, states });
  }
}

const images = new Map();
async function exists(path) {
  if (!images.has(path)) images.set(path, (await stack.readImage(path)) !== undefined);
  return images.get(path);
}

let drawn = 0;
let full = 0;
let partial = 0;
const untextured = new Set();
const missingImages = new Set();
for (const { name, states } of requests) {
  const appearance = resolveBlockAppearance(name, states);
  if (appearance.shape.kind === "empty") continue;
  drawn += 1;
  const textures = resolveBlockTextures(stack, name, states, appearance);
  const wanted = appearance.shape.kind === "plant" ? [textures?.cross] : (textures?.faces ?? []);
  let found = 0;
  for (const texture of wanted) {
    if (texture === undefined) continue;
    if (await exists(texture.path)) found += 1;
    else missingImages.add(texture.path);
  }
  const needed = appearance.shape.kind === "plant" ? 1 : 6;
  if (found === needed) full += 1;
  else if (found > 0) partial += 1;
  else untextured.add(name.replace(/^minecraft:/, ""));
}
console.log(
  `${requests.length} appearances, ${drawn} drawn: ${full} fully textured, ${partial} partly, ` +
    `${drawn - full - partial} with colors only`,
);
console.log(
  `Blocks with colors only (${untextured.size}):`,
  [...untextured].sort((a, b) => (a < b ? -1 : 1)).join(" "),
);
console.log(
  `Missing images (${missingImages.size}):`,
  [...missingImages].sort((a, b) => (a < b ? -1 : 1)).join(" "),
);
