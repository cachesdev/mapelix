// Reports which block appearances a resource pack stack textures.
// Usage: node scripts/texture-coverage.mjs <pack> [<pack> ...]   (highest priority first)
//          [--world <directory> [--dimension overworld|nether|the-end] [--center <x>,<z>]
//           [--radius <chunks>]]
// Build first. Without `--world` it checks every known block and its listed variants. With
// `--world` it checks the blocks a square of chunks around the center (the spawn by default)
// holds, counts them, and lists those drawn with plain colors, most common first.
import { resolveBlockAppearance } from "../dist/blocks/block-appearance.js";
import { BEDROCK_BLOCK_COLORS } from "../dist/blocks/bedrock-colors.js";
import { WorldDatabase } from "../dist/leveldb/world-database.js";
import { openResourcePackStack, resolveBlockTextures } from "../dist/textures/index.js";
import { ChunkSource } from "../dist/world/chunk-source.js";
import { readLevelInfo } from "../dist/world/level-info.js";

const options = {};
const sources = [];
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument.startsWith("--")) options[argument.slice(2)] = process.argv[++index];
  else sources.push(argument);
}
if (sources.length === 0) {
  throw new Error("Usage: texture-coverage.mjs <pack> [<pack> ...] [--world <directory>]");
}
const stack = await openResourcePackStack(sources);
console.log(
  `Stack ${stack.fingerprint}:`,
  stack.packs.map((pack) => pack.info),
);

const images = new Map();
async function exists(path) {
  if (!images.has(path)) images.set(path, (await stack.readImage(path)) !== undefined);
  return images.get(path);
}

const missingImages = new Set();
/** "empty", "full", "partial", or "colors" for one block appearance. */
async function coverage(name, states) {
  const appearance = resolveBlockAppearance(name, states);
  if (appearance.shape.kind === "empty") return "empty";
  const textures = resolveBlockTextures(stack, name, states, appearance);
  const wanted = appearance.shape.kind === "plant" ? [textures?.cross] : (textures?.faces ?? []);
  let found = 0;
  for (const texture of wanted) {
    if (texture === undefined) continue;
    if (await exists(texture.path)) found += 1;
    else missingImages.add(texture.path);
  }
  const needed = appearance.shape.kind === "plant" ? 1 : 6;
  return found === needed ? "full" : found > 0 ? "partial" : "colors";
}

const sorted = (values) => [...values].sort((a, b) => (a < b ? -1 : 1));
const short = (name) => name.replace(/^minecraft:/, "");

if (options.world === undefined) {
  // The same requests as the appearance parity check: every block, its listed variants and axes.
  const requests = [];
  for (const name of Object.keys(BEDROCK_BLOCK_COLORS).sort()) {
    const variants = BEDROCK_BLOCK_COLORS[name]?.variants?.map((row) => row.states) ?? [];
    for (const states of [{}, ...variants, { pillar_axis: "x" }, { pillar_axis: "z" }]) {
      requests.push({ name: `minecraft:${name}`, states });
    }
  }
  const counts = { empty: 0, full: 0, partial: 0, colors: 0 };
  const untextured = new Set();
  for (const { name, states } of requests) {
    const result = await coverage(name, states);
    counts[result] += 1;
    if (result === "colors") untextured.add(short(name));
  }
  console.log(
    `${requests.length} appearances, ${requests.length - counts.empty} drawn: ${counts.full} ` +
      `fully textured, ${counts.partial} partly, ${counts.colors} with colors only`,
  );
  console.log(`Blocks with colors only (${untextured.size}):`, sorted(untextured).join(" "));
} else {
  const radius = Number(options.radius ?? 8);
  const center = options.center
    ? options.center.split(",").map(Number)
    : await readLevelInfo(options.world).then(({ spawn }) => [spawn.x, spawn.z]);
  const database = WorldDatabase.open(options.world);
  const chunks = new ChunkSource(database, options.dimension ?? "overworld");
  const centerX = Math.floor(center[0] / 16);
  const centerZ = Math.floor(center[1] / 16);
  // Cells per block name and state set, then one coverage check per distinct appearance.
  const cells = new Map();
  for (let chunkX = centerX - radius; chunkX <= centerX + radius; chunkX += 1) {
    for (let chunkZ = centerZ - radius; chunkZ <= centerZ + radius; chunkZ += 1) {
      for (const section of chunks.chunk(chunkX, chunkZ)?.sections ?? []) {
        const { palette, states, indexes } = section.primary;
        const perIndex = new Uint32Array(palette.length);
        for (const index of indexes) perIndex[index] += 1;
        for (const [index, name] of palette.entries()) {
          if (perIndex[index] === 0) continue;
          const key = JSON.stringify([name, states?.[index] ?? {}], (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
          );
          const entry = cells.get(key) ?? { name, states: states?.[index] ?? {}, count: 0 };
          entry.count += perIndex[index];
          cells.set(key, entry);
        }
      }
    }
  }
  database.close();
  const byBlock = new Map();
  for (const { name, states, count } of cells.values()) {
    const result = await coverage(name, states);
    if (result === "full" || result === "empty") continue;
    const row = byBlock.get(short(name)) ?? { colors: 0, partial: 0 };
    row[result] += count;
    byBlock.set(short(name), row);
  }
  const span = radius * 2 + 1;
  console.log(
    `${span}x${span} chunks around ${center[0]},${center[1]}: ${cells.size} block appearances, ` +
      `${byBlock.size} blocks not fully textured`,
  );
  const rows = [...byBlock.entries()].sort(
    ([, a], [, b]) => b.colors + b.partial - (a.colors + a.partial),
  );
  for (const [name, { colors, partial }] of rows) {
    console.log(
      `  ${name.padEnd(40)} ${String(colors + partial).padStart(8)}` +
        (colors > 0 && partial > 0
          ? `  (${partial} partly textured)`
          : partial > 0
            ? "  partly"
            : ""),
    );
  }
}
console.log(`Missing images (${missingImages.size}):`, sorted(missingImages).join(" "));
