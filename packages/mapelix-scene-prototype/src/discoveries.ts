import { DIMENSIONS, parseDimension, type Dimension, type VerticalBounds } from "./dimensions.js";
import { MAX_BLOCK_COORDINATE, selectionContains, type HorizontalSelection } from "./selection.js";

/** Separate from terrain format/version: detector changes invalidate indexes, not meshes. */
export const DISCOVERY_SCHEMA_VERSION = 1;
export const DISCOVERY_TILE_SPAN = 32;
export const DISCOVERY_LIMITS = {
  tileSpan: 32,
  schemaVersion: 1,
  viewDistance: 64,
  maxViewDistance: 96,
  memoryBudget: 4 * 1024 * 1024,
  maxTiles: 64,
  maxRequests: 1,
  maxMarkers: 128,
  maxQueryBlocks: 100_000,
} as const;
export type DiscoveryCategory =
  | "ores"
  | "spawners"
  | "containers"
  | "vaults"
  | "amethyst"
  | "sculk"
  | "landmarks";
export const DISCOVERY_CATEGORIES: readonly DiscoveryCategory[] = [
  "ores",
  "spawners",
  "containers",
  "vaults",
  "amethyst",
  "sculk",
  "landmarks",
];
export type Exposure = "buried" | "exposed" | "unknown";
export interface DiscoveryKind {
  readonly id: string;
  readonly label: string;
  readonly category: DiscoveryCategory;
  readonly color: number;
  readonly blocks: readonly string[];
}
const kind = (
  id: string,
  label: string,
  category: DiscoveryCategory,
  color: number,
  ...blocks: string[]
): DiscoveryKind => ({ id, label, category, color, blocks });

// Stable numeric order is part of schema 1. Stored indexes contain block types/positions only.
export const DISCOVERY_KINDS: readonly DiscoveryKind[] = [
  kind("coal", "Coal", "ores", 0x777777, "coal_ore", "deepslate_coal_ore"),
  kind("iron", "Iron", "ores", 0xd5ad91, "iron_ore", "deepslate_iron_ore"),
  kind("copper", "Copper", "ores", 0xe18d62, "copper_ore", "deepslate_copper_ore"),
  kind("gold", "Gold", "ores", 0xf6cb4e, "gold_ore", "deepslate_gold_ore", "nether_gold_ore"),
  kind(
    "redstone",
    "Redstone",
    "ores",
    0xf04444,
    "redstone_ore",
    "lit_redstone_ore",
    "deepslate_redstone_ore",
    "lit_deepslate_redstone_ore",
    "deepslate_lit_redstone_ore",
  ),
  kind("lapis", "Lapis lazuli", "ores", 0x557ced, "lapis_ore", "deepslate_lapis_ore"),
  kind("diamond", "Diamond", "ores", 0x58e5df, "diamond_ore", "deepslate_diamond_ore"),
  kind("emerald", "Emerald", "ores", 0x4fed8b, "emerald_ore", "deepslate_emerald_ore"),
  kind("quartz", "Nether quartz", "ores", 0xeee6d6, "quartz_ore", "nether_quartz_ore"),
  kind("ancient_debris", "Ancient debris", "ores", 0xbc9183, "ancient_debris"),
  kind("other_ore", "Other ores", "ores", 0xc9c9c9),
  kind(
    "spawner",
    "Monster spawner",
    "spawners",
    0xb77af2,
    "mob_spawner",
    "monster_spawner",
    "spawner",
  ),
  kind("trial_spawner", "Trial spawner", "spawners", 0xf4a65e, "trial_spawner"),
  kind("chest", "Chest", "containers", 0xe5bb64, "chest"),
  kind("trapped_chest", "Trapped chest", "containers", 0xf88060, "trapped_chest"),
  kind("ender_chest", "Ender chest", "containers", 0x8fc5a9, "ender_chest"),
  kind("barrel", "Barrel", "containers", 0xc5a173, "barrel"),
  kind("shulker", "Shulker box", "containers", 0xc19bdf, "shulker_box", "undyed_shulker_box"),
  kind("decorated_pot", "Decorated pot", "containers", 0xd68e76, "decorated_pot"),
  kind("vault", "Vault", "vaults", 0xf9b85a, "vault"),
  kind("budding_amethyst", "Budding amethyst", "amethyst", 0xbe94ed, "budding_amethyst"),
  kind(
    "amethyst",
    "Amethyst crystals",
    "amethyst",
    0xa98bf2,
    "amethyst_cluster",
    "small_amethyst_bud",
    "medium_amethyst_bud",
    "large_amethyst_bud",
  ),
  kind("sculk_catalyst", "Sculk catalyst", "sculk", 0x52caba, "sculk_catalyst"),
  kind("sculk_shrieker", "Sculk shrieker", "sculk", 0x86a6b8, "sculk_shrieker"),
  kind(
    "sculk_sensor",
    "Sculk sensor",
    "sculk",
    0x61aab3,
    "sculk_sensor",
    "calibrated_sculk_sensor",
  ),
  kind("end_portal", "End portal", "landmarks", 0xb0d9a9, "end_portal_frame", "end_portal"),
  kind("end_gateway", "End gateway", "landmarks", 0xb08bdd, "end_gateway"),
  kind("nether_portal", "Nether portal", "landmarks", 0xc985f4, "portal", "nether_portal"),
  kind(
    "rails",
    "Rails",
    "landmarks",
    0xd4c27f,
    "rail",
    "golden_rail",
    "powered_rail",
    "detector_rail",
    "activator_rail",
  ),
];
const byName = new Map(
  DISCOVERY_KINDS.flatMap((value, index) => value.blocks.map((name) => [name, index] as const)),
);
export function discoveryKind(block: string): number | undefined {
  if (!block.startsWith("minecraft:")) return undefined;
  const name = block.slice(10);
  return (
    byName.get(name) ??
    (name.endsWith("_ore") ? 10 : name.endsWith("_shulker_box") ? 17 : undefined)
  );
}

export interface DiscoveryRequest {
  readonly x: number;
  readonly z: number;
}
export interface DiscoveryTile extends DiscoveryRequest {
  readonly dimension: Dimension;
  /** Bitmask of the four stored chunk columns owned by this tile. */
  readonly sourceChunks: number;
  /** x(5), z(5), y+64(9), kind(6), exposure(2); one word per interesting block. */
  readonly blocks: Uint32Array;
}
export interface DiscoveryBlock {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly kind: number;
  readonly exposure: Exposure;
}
const EXPOSURES: readonly Exposure[] = ["buried", "exposed", "unknown"];
const MAGIC = 0x3144_584d; // MXD1
const HEADER = 32;
const POSITION_MASK = (1 << 19) - 1;
const NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

export function assertDiscoveryRequest({ x, z }: DiscoveryRequest): void {
  if (
    ![x, z].every(
      (value) =>
        Number.isSafeInteger(value) &&
        Math.abs(value) <= Math.floor(MAX_BLOCK_COORDINATE / DISCOVERY_TILE_SPAN),
    )
  )
    throw new RangeError("Discovery tile coordinates must be integers within world bounds");
}

export function packDiscoveryBlock(
  x: number,
  y: number,
  z: number,
  type: number,
  exposure: Exposure,
): number {
  return x | (z << 5) | ((y + 64) << 10) | (type << 19) | (EXPOSURES.indexOf(exposure) << 25);
}

export function unpackDiscoveryBlock(tile: DiscoveryTile, word: number): DiscoveryBlock {
  return {
    x: tile.x * 32 + (word & 31),
    z: tile.z * 32 + ((word >>> 5) & 31),
    y: ((word >>> 10) & 511) - 64,
    kind: (word >>> 19) & 63,
    exposure: EXPOSURES[word >>> 25]!,
  };
}

export function encodeDiscoveryTile(tile: DiscoveryTile): Uint8Array {
  assertDiscoveryRequest(tile);
  const bytes = new Uint8Array(HEADER + tile.blocks.byteLength),
    view = new DataView(bytes.buffer);
  for (const [index, value] of [
    MAGIC,
    DISCOVERY_SCHEMA_VERSION,
    DIMENSIONS[tile.dimension].storageId,
    tile.x,
    tile.z,
    tile.sourceChunks,
    tile.blocks.length,
    0,
  ].entries())
    view.setInt32(index * 4, value, true);
  for (let i = 0; i < tile.blocks.length; i++)
    view.setUint32(HEADER + i * 4, tile.blocks[i]!, true);
  return bytes;
}

export function decodeDiscoveryTile(bytes: Uint8Array): DiscoveryTile {
  if (bytes.byteLength < HEADER || bytes.byteLength > HEADER + 32 * 32 * 384 * 4)
    throw new Error("Invalid discovery payload size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== DISCOVERY_SCHEMA_VERSION)
    throw new Error("Unsupported discovery schema");
  const dimensions: readonly Dimension[] = ["overworld", "nether", "the-end"],
    dimension = dimensions[view.getUint32(8, true)];
  if (!dimension) throw new Error("Invalid discovery dimension");
  const x = view.getInt32(12, true),
    z = view.getInt32(16, true),
    sourceChunks = view.getUint32(20, true),
    count = view.getUint32(24, true);
  assertDiscoveryRequest({ x, z });
  if (
    sourceChunks > 15 ||
    view.getUint32(28, true) !== 0 ||
    HEADER + count * 4 !== bytes.byteLength
  )
    throw new Error("Invalid discovery header");
  const blocks = new Uint32Array(count),
    config = DIMENSIONS[dimension];
  for (let index = 0; index < count; index++) {
    const word = view.getUint32(HEADER + index * 4, true),
      y = ((word >>> 10) & 511) - 64;
    if (
      word >>> 25 > 2 ||
      ((word >>> 19) & 63) >= DISCOVERY_KINDS.length ||
      y < config.minY ||
      y >= config.maxY
    )
      throw new Error("Invalid indexed block");
    blocks[index] = word;
  }
  return { dimension, x, z, sourceChunks, blocks };
}

/** Revision is the fixed snapshot revision, independent of terrain strategy, LOD and bounds. */
export function discoveryCacheKey(
  revision: string,
  dimension: Dimension,
  tile: DiscoveryRequest,
): string {
  assertDiscoveryRequest(tile);
  parseDimension(dimension);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(revision)) throw new RangeError("Invalid discovery revision");
  return `${revision}/discoveries-v${DISCOVERY_SCHEMA_VERSION}/${dimension}/${tile.x}/${tile.z}`;
}

export interface DiscoveryFilters {
  readonly enabled: boolean;
  readonly categories: readonly DiscoveryCategory[];
  readonly ores: readonly string[];
  readonly exposure: "all" | "exposed" | "buried";
  readonly allHeights: boolean;
}
export const DEFAULT_DISCOVERY_FILTERS: DiscoveryFilters = {
  enabled: false,
  categories: DISCOVERY_CATEGORIES.filter((category) => category !== "ores"),
  ores: DISCOVERY_KINDS.filter((value) => value.category === "ores").map((value) => value.id),
  exposure: "all",
  allHeights: false,
};

export function discoveryFilters(input: Partial<DiscoveryFilters> = {}): DiscoveryFilters {
  const result = { ...DEFAULT_DISCOVERY_FILTERS, ...input };
  if (
    typeof result.enabled !== "boolean" ||
    typeof result.allHeights !== "boolean" ||
    !["all", "exposed", "buried"].includes(result.exposure) ||
    !Array.isArray(result.categories) ||
    !result.categories.every((value) => DISCOVERY_CATEGORIES.includes(value)) ||
    !Array.isArray(result.ores) ||
    !result.ores.every((value) =>
      DISCOVERY_KINDS.some((entry) => entry.category === "ores" && entry.id === value),
    )
  )
    throw new RangeError("Invalid discovery filters");
  return {
    ...result,
    categories: [...new Set(result.categories)],
    ores: [...new Set(result.ores)],
  };
}

export function discoveryFiltersFromSearch(params: URLSearchParams): DiscoveryFilters | undefined {
  const categories = params.get("discover");
  if (categories === null) return undefined;
  const selectedCategories = categories === "off" ? params.get("discoveryTypes") : categories;
  const ores = params.get("ores"),
    exposure = params.get("exposure") ?? "all";
  if (!["all", "exposed", "buried"].includes(exposure))
    throw new RangeError("Invalid discovery exposure");
  return discoveryFilters({
    enabled: categories !== "off",
    ...(selectedCategories === null
      ? {}
      : {
          categories:
            selectedCategories === "" ? [] : (selectedCategories.split(",") as DiscoveryCategory[]),
        }),
    ...(ores === null ? {} : { ores: ores === "" ? [] : ores.split(",") }),
    exposure: exposure as DiscoveryFilters["exposure"],
    allHeights: params.get("allY") === "1",
  });
}

export function discoveryFilterSearch(input: DiscoveryFilters): URLSearchParams {
  const f = discoveryFilters(input);
  if (!f.enabled && JSON.stringify(f) === JSON.stringify(DEFAULT_DISCOVERY_FILTERS))
    return new URLSearchParams({ discover: "off" });
  return new URLSearchParams({
    discover: f.enabled ? f.categories.join(",") : "off",
    ...(!f.enabled ? { discoveryTypes: f.categories.join(",") } : {}),
    ores: f.ores.join(","),
    exposure: f.exposure,
    allY: f.allHeights ? "1" : "0",
  });
}

export interface DiscoveryGroup {
  readonly dimension: Dimension;
  readonly id: string;
  readonly kind: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly count: number;
  readonly exposed: number;
  readonly buried: number;
  readonly unknown: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
}
export interface DiscoveryQuery {
  readonly groups: readonly DiscoveryGroup[];
  readonly matchingBlocks: number;
  readonly limited: boolean;
}

/** Six-connected components across tile boundaries; grouping never depends on terrain meshes. */
export function* queryDiscoverySteps(
  tiles: Iterable<DiscoveryTile>,
  filters: DiscoveryFilters,
  window: VerticalBounds,
  focus: { x: number; y: number; z: number },
  selection?: HorizontalSelection,
): Generator<void, DiscoveryQuery> {
  if (!filters.enabled) return { groups: [], matchingBlocks: 0, limited: false };
  const allowed = new Set(
    DISCOVERY_KINDS.flatMap((entry, index) =>
      filters.categories.includes(entry.category) &&
      (entry.category !== "ores" || filters.ores.includes(entry.id))
        ? [index]
        : [],
    ),
  );
  const pending = new Map<string, { tile: DiscoveryTile; words: Map<number, number> }>();
  let matchingBlocks = 0,
    accepted = 0;
  let steps = 0;
  for (const tile of tiles) {
    const words = new Map<number, number>();
    for (const word of tile.blocks) {
      if (++steps % 256 === 0) yield;
      const b = unpackDiscoveryBlock(tile, word);
      if (
        !allowed.has(b.kind) ||
        (!filters.allHeights && (b.y < window.minY || b.y >= window.maxY)) ||
        (selection && !selectionContains(selection, b.x, b.z)) ||
        (filters.exposure !== "all" && filters.exposure !== b.exposure)
      )
        continue;
      matchingBlocks++;
      if (accepted >= DISCOVERY_LIMITS.maxQueryBlocks) continue;
      words.set(word & ((1 << 25) - 1), word);
      accepted++;
    }
    pending.set(`${tile.dimension}/${tile.x}/${tile.z}`, { tile, words });
  }
  const groups: DiscoveryGroup[] = [];
  const distance = (b: { x: number; y: number; z: number }) =>
    (b.x - focus.x) ** 2 + (b.z - focus.z) ** 2 + (b.y - focus.y) ** 2;
  const compare = (a: DiscoveryGroup, b: DiscoveryGroup) =>
    distance(a) - distance(b) || a.id.localeCompare(b.id);
  let totalGroups = 0;
  // Retain only the nearest bounded set; never sort an unbounded list at the end of a frame.
  const keepNearest = (group: DiscoveryGroup) => {
    if (groups.length < DISCOVERY_LIMITS.maxMarkers) {
      let at = groups.length;
      groups.push(group);
      while (at > 0) {
        const parent = Math.floor((at - 1) / 2);
        if (compare(groups[at]!, groups[parent]!) <= 0) break;
        [groups[at], groups[parent]] = [groups[parent]!, groups[at]!];
        at = parent;
      }
    } else if (compare(group, groups[0]!) < 0) {
      groups[0] = group;
      let at = 0;
      while (true) {
        const left = at * 2 + 1,
          right = left + 1;
        let worst = at;
        if (left < groups.length && compare(groups[left]!, groups[worst]!) > 0) worst = left;
        if (right < groups.length && compare(groups[right]!, groups[worst]!) > 0) worst = right;
        if (worst === at) break;
        [groups[at], groups[worst]] = [groups[worst]!, groups[at]!];
        at = worst;
      }
    }
  };
  for (const source of pending.values()) {
    while (source.words.size) {
      const firstKey = source.words.keys().next().value!,
        firstWord = source.words.get(firstKey)!;
      source.words.delete(firstKey);
      const first = unpackDiscoveryBlock(source.tile, firstWord);
      let representative = first,
        count = 0,
        exposed = 0,
        buried = 0,
        unknown = 0;
      let minX = first.x,
        maxX = first.x + 1,
        minY = first.y,
        maxY = first.y + 1,
        minZ = first.z,
        maxZ = first.z + 1;
      const queue: DiscoveryBlock[] = [first];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        if (++steps % 256 === 0) yield;
        const b = queue[cursor]!;
        count++;
        if (b.exposure === "exposed") exposed++;
        else if (b.exposure === "buried") buried++;
        else unknown++;
        if (distance(b) < distance(representative)) representative = b;
        minX = Math.min(minX, b.x);
        maxX = Math.max(maxX, b.x + 1);
        minY = Math.min(minY, b.y);
        maxY = Math.max(maxY, b.y + 1);
        minZ = Math.min(minZ, b.z);
        maxZ = Math.max(maxZ, b.z + 1);
        for (const [dx, dy, dz] of NEIGHBORS) {
          const x = b.x + dx!,
            y = b.y + dy!,
            z = b.z + dz!;
          if (y < -64 || y >= 320) continue;
          const neighbor = pending.get(
            `${source.tile.dimension}/${Math.floor(x / 32)}/${Math.floor(z / 32)}`,
          );
          if (!neighbor) continue;
          const key =
            (packDiscoveryBlock(x & 31, y, z & 31, b.kind, "buried") & POSITION_MASK) |
            (b.kind << 19);
          const word = neighbor.words.get(key);
          if (word === undefined) continue;
          neighbor.words.delete(key);
          queue.push(unpackDiscoveryBlock(neighbor.tile, word));
        }
      }
      totalGroups++;
      keepNearest({
        dimension: source.tile.dimension,
        id: `${source.tile.dimension}/${first.kind}/${minX}/${minY}/${minZ}`,
        kind: first.kind,
        x: representative.x,
        y: representative.y,
        z: representative.z,
        count,
        exposed,
        buried,
        unknown,
        minX,
        maxX,
        minY,
        maxY,
        minZ,
        maxZ,
      });
    }
  }
  groups.sort(compare);
  return {
    groups,
    matchingBlocks,
    limited: accepted < matchingBlocks || totalGroups > DISCOVERY_LIMITS.maxMarkers,
  };
}

/** Synchronous adapter for offline tools; interactive viewers advance the same generator in small steps. */
export function queryDiscoveries(...args: Parameters<typeof queryDiscoverySteps>): DiscoveryQuery {
  const iterator = queryDiscoverySteps(...args);
  let step = iterator.next();
  while (!step.done) step = iterator.next();
  return step.value;
}
