import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const source = join(root, "packages/mapelix-scene-prototype/dist");
const target = join(
  root,
  "packages/mapelix-scene-prototype/.local/underground-m0-dist",
);
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
function edit(file, transform) {
  const path = join(target, file);
  const before = readFileSync(path, "utf8");
  const after = transform(before);
  if (before === after)
    throw new Error(`No experimental edit applied: ${file}`);
  writeFileSync(path, after);
}
function replace(code, from, to) {
  if (!code.includes(from))
    throw new Error(`Missing prototype anchor: ${from}`);
  return code.replaceAll(from, to);
}
writeFileSync(
  join(target, "mesh/m0-range.js"),
  `
export const state = { active: false, minY: -64, maxY: 320, sectionHits: 0, sectionMisses: 0 };
export let ALLOC_MIN_Y = -64, ALLOC_MAX_Y = 320, HEIGHT = 384, NO_BLOCK = -65;
export function configure(active, minY = -64, maxY = 320, floor = -64, roof = 320) {
  state.active = active; state.minY = minY; state.maxY = maxY;
  ALLOC_MIN_Y = active ? Math.max(floor, Math.floor((minY - 1) / 16) * 16) : -64;
  ALLOC_MAX_Y = active ? Math.min(roof, Math.ceil((maxY + 1) / 16) * 16) : 320;
  HEIGHT = ALLOC_MAX_Y - ALLOC_MIN_Y; NO_BLOCK = ALLOC_MIN_Y - 1;
}
`,
);
edit("mesh/region-volume.js", (code) => {
  code = replace(
    code,
    'import { BASE_REGION_SPAN, WORLD_MAX_Y, WORLD_MIN_Y } from "../format.js";',
    'import { BASE_REGION_SPAN } from "../format.js";\nimport { decodeSection } from "../world/chunk-source.js";\nimport { state, ALLOC_MIN_Y as WORLD_MIN_Y, ALLOC_MAX_Y as WORLD_MAX_Y, HEIGHT as VOLUME_HEIGHT, NO_BLOCK } from "./m0-range.js";',
  );
  code = replace(
    code,
    "export const VOLUME_HEIGHT = WORLD_MAX_Y - WORLD_MIN_Y;",
    'export { HEIGHT as VOLUME_HEIGHT } from "./m0-range.js";',
  );
  code = replace(
    code,
    "export const NO_BLOCK = WORLD_MIN_Y - 1;",
    'export { NO_BLOCK } from "./m0-range.js";',
  );
  code = replace(
    code,
    "chunks.chunk(originX / 16 + column, originZ / 16 + row)",
    "windowChunk(chunks, originX / 16 + column, originZ / 16 + row)",
  );
  code += `
// Experimental section cache; no final engine API is introduced.
const caches = new WeakMap();
function windowChunk(chunks, x, z) {
  if (!state.active) return chunks.chunk(x, z);
  const records = chunks.records(x, z);
  if (!records) return undefined;
  let cache = caches.get(chunks);
  if (!cache) caches.set(chunks, cache = new Map());
  const sections = [];
  for (const record of records.sections) {
    if (record.y * 16 < WORLD_MIN_Y || record.y * 16 >= WORLD_MAX_Y) continue;
    const key = x + ',' + z + ',' + record.y;
    let section = cache.get(key);
    if (section) { cache.delete(key); cache.set(key, section); state.sectionHits++; }
    else { section = decodeSection(record); state.sectionMisses++; if (section) cache.set(key, section); }
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    if (section) sections.push(section);
  }
  return { ...records, sections };
}
`;
  return code;
});
edit("mesh/voxel-mesher.js", (code) => {
  code = replace(
    code,
    "QuadMaterial, WORLD_MAX_Y, WORLD_MIN_Y, packQuadWord0",
    "QuadMaterial, packQuadWord0",
  );
  code =
    'import { state, ALLOC_MIN_Y as WORLD_MIN_Y, ALLOC_MAX_Y as WORLD_MAX_Y } from "./m0-range.js";\n' +
    code;
  code = replace(
    code,
    ".fill(1 - WORLD_MIN_Y)",
    ".fill(state.active ? 1 : 1 - WORLD_MIN_Y)",
  );
  code = replace(
    code,
    "Math.max(WORLD_MIN_Y, lowest + WORLD_MIN_Y - 1)",
    "Math.max(state.active ? state.minY : WORLD_MIN_Y, lowest + WORLD_MIN_Y - 1)",
  );
  code = replace(
    code,
    "const top = topBlock[column];",
    "const top = Math.min(topBlock[column], state.active ? state.maxY - 1 : WORLD_MAX_Y - 1);",
  );
  code = replace(
    code,
    "const top = this.volume.topBlock[column];",
    "const top = Math.min(this.volume.topBlock[column], state.active ? state.maxY - 1 : WORLD_MAX_Y - 1);",
  );
  code = replace(
    code,
    "y <= this.volume.topBlock[column];",
    "y <= Math.min(this.volume.topBlock[column], state.active ? state.maxY - 1 : WORLD_MAX_Y - 1);",
  );
  return code;
});
edit("mesh/chunk-voxels.js", (code) => {
  code =
    'import { state, ALLOC_MIN_Y, ALLOC_MAX_Y } from "./m0-range.js";\n' + code;
  code = replace(
    code,
    "return this.chunks.config.geometry;",
    'return state.active ? "interior" : this.chunks.config.geometry;',
  );
  code = replace(
    code,
    "if (record.y * 16 >= ceilingY)",
    "if (record.y * 16 >= ceilingY || (state.active && (record.y * 16 < ALLOC_MIN_Y || record.y * 16 >= ALLOC_MAX_Y)))",
  );
  code = replace(
    code,
    'this.chunks.config.geometry === "surface" &&',
    '!state.active && this.chunks.config.geometry === "surface" &&',
  );
  return code;
});
console.log(
  JSON.stringify({
    experimentalRuntime: target,
    base: "e02cf7c",
    trackedSourcesChanged: false,
  }),
);
