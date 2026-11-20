import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";

import {
  floorDiv,
  type ShadowOpacityRun,
  type SurfaceBlock,
  type SurfaceColorLayer,
} from "./tile.js";
import type { SurfaceBlockStyle } from "./surface-style.js";
import type { ChunkSurface } from "./world.js";

/**
 * Optional on-disk store of extracted chunk surfaces, shared by consecutive renders of the same
 * world directory.
 *
 * Layout: `<root>/<namespace>/<config>/<storageTileX>_<storageTileZ>.pack`. The namespace digests
 * the caller's renderer identity and settings; the config digests the dimension, surface range and
 * surface style. One pack holds the surfaces of the chunks of one 256 x 256 block storage tile.
 * Every entry records the fingerprint of the chunk records it was extracted from and is only used
 * while the current fingerprint is identical. Packs carry a SHA-256 trailer; a missing, truncated,
 * corrupt or foreign pack or entry is ignored and the surface is extracted again, so the store can
 * never change rendered pixels.
 */

const PACK_MAGIC = 0x5053584d; // "MXSP"
export const SURFACE_PACK_VERSION = 1;
const HEADER_BYTES = 48;
const DIGEST_BYTES = 32;
const PACK_NAME = /^(-?\d+)_(-?\d+)\.pack$/;
const DIGEST_NAME = /^[a-f0-9]{32}$/;
const MIB = 1024 * 1024;

/** Default size bound of an on-disk surface store. */
export const DEFAULT_SURFACE_STORE_MIB = 512;

/** Per-job view of the store, built by the coordinating process. */
export interface SurfaceStoreJob {
  /** Absolute config directory below the validated store root. */
  readonly directory: string;
  /** Full config digest (64 hex characters) stored in each pack header. */
  readonly config: string;
  readonly dimension: number;
  /** Current fingerprints of every chunk in the storage tiles this job can read, keyed `x,z`. */
  readonly fingerprints: ReadonlyMap<string, string>;
}

/** A newly extracted surface, encoded by a renderer for the single store writer. */
export interface StoredSurfaceEntry {
  readonly directory: string;
  readonly config: string;
  readonly dimension: number;
  readonly x: number;
  readonly z: number;
  readonly scoped: boolean;
  readonly fingerprint: string;
  readonly blob: Uint8Array;
}

export interface SurfaceStoreStats {
  /** Chunk surfaces read from the store instead of being extracted. */
  hits: number;
  /** Chunk surfaces extracted and offered to the store. */
  stored: number;
  /** Packs or entries ignored because they failed verification. */
  rejected: number;
  /** Bytes written to the store by the last flush. */
  writtenBytes: number;
  /** Packs removed by stale-entry cleanup or the size bound. */
  removedPacks: number;
  /** Store size after the last flush. */
  totalBytes: number;
}

export function createSurfaceStoreStats(): SurfaceStoreStats {
  return { hits: 0, stored: 0, rejected: 0, writtenBytes: 0, removedPacks: 0, totalBytes: 0 };
}

export function surfaceStoreDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function surfacePackName(chunkX: number, chunkZ: number): string {
  return `${floorDiv(chunkX, 16)}_${floorDiv(chunkZ, 16)}.pack`;
}

function entryKey(x: number, z: number, scoped: boolean): string {
  return `${x},${z},${scoped ? 1 : 0}`;
}

// ---------------------------------------------------------------------------------------------
// Surface encoding

const COLUMN_KEYS = new Set([
  "name",
  "style",
  "y",
  "supportY",
  "biomeId",
  "fluidDepth",
  "underwaterName",
  "underwaterStyle",
  "colorLayers",
  "shadowRuns",
]);
const LAYER_KEYS = new Set([
  "name",
  "style",
  "count",
  "fluidDepth",
  "underwaterName",
  "underwaterStyle",
]);
const STYLE_KEYS = new Set(["style", "underwaterStyle"]);
const RUN_KEYS = ["minY", "maxY", "opacity"] as const;

type Plain = Record<string, unknown>;

/**
 * Encodes a chunk surface losslessly, or returns undefined when the surface holds a value this
 * format cannot reproduce exactly (unknown fields, undefined-valued fields, non-finite numbers or
 * negative zero). Such surfaces are simply not stored.
 */
export function encodeChunkSurface(surface: ChunkSurface): Uint8Array | undefined {
  if (surface.length !== 256) return undefined;
  const styles: unknown[] = [];
  const styleIndexes = new Map<string, number>();
  const intern = (style: unknown): number | undefined => {
    if (style === null || typeof style !== "object") return undefined;
    const text = JSON.stringify(style);
    if (!exactJson(style)) return undefined;
    let index = styleIndexes.get(text);
    if (index === undefined) {
      index = styles.length;
      styles.push(style);
      styleIndexes.set(text, index);
    }
    return index;
  };
  const encodeFields = (
    value: Plain,
    keys: ReadonlySet<string>,
    nested: (key: string, field: unknown) => unknown,
  ): Plain | undefined => {
    const output: Plain = {};
    for (const key of Object.keys(value)) {
      const field = value[key];
      if (!keys.has(key) || field === undefined) return undefined;
      if (STYLE_KEYS.has(key)) {
        const index = intern(field);
        if (index === undefined) return undefined;
        output[key] = index;
        continue;
      }
      const encoded = nested(key, field);
      if (encoded === undefined) return undefined;
      output[key] = encoded;
    }
    return output;
  };
  const scalar = (field: unknown): unknown =>
    typeof field === "string" || isExactNumber(field) ? field : undefined;
  const columns: (Plain | null)[] = [];
  for (const column of surface) {
    if (column === undefined) {
      columns.push(null);
      continue;
    }
    const encoded = encodeFields(column as unknown as Plain, COLUMN_KEYS, (key, field) => {
      if (key === "shadowRuns") return encodeRuns(field);
      if (key === "colorLayers") {
        if (!Array.isArray(field)) return undefined;
        const layers: Plain[] = [];
        for (const layer of field as unknown[]) {
          if (layer === null || typeof layer !== "object") return undefined;
          const value = encodeFields(layer as Plain, LAYER_KEYS, (_key, item) => scalar(item));
          if (value === undefined) return undefined;
          layers.push(value);
        }
        return layers;
      }
      return scalar(field);
    });
    if (encoded === undefined) return undefined;
    columns.push(encoded);
  }
  return deflateRawSync(JSON.stringify({ s: styles, c: columns }), { level: 1 });
}

function encodeRuns(field: unknown): number[] | undefined {
  if (!Array.isArray(field)) return undefined;
  const flat: number[] = [];
  for (const run of field as unknown[]) {
    if (run === null || typeof run !== "object") return undefined;
    const keys = Object.keys(run);
    if (keys.length !== 3) return undefined;
    for (const key of RUN_KEYS) {
      const value = (run as Plain)[key];
      if (!isExactNumber(value)) return undefined;
      flat.push(value);
    }
  }
  return flat;
}

/** Decodes an encoded surface, or returns undefined when the bytes are not a valid surface. */
export function decodeChunkSurface(blob: Uint8Array): ChunkSurface | undefined {
  let document: unknown;
  try {
    document = JSON.parse(inflateRawSync(blob).toString("utf8"));
  } catch {
    return undefined;
  }
  if (document === null || typeof document !== "object") return undefined;
  const styles = (document as Plain).s;
  const columns = (document as Plain).c;
  if (!Array.isArray(styles) || !Array.isArray(columns) || columns.length !== 256) return undefined;
  if (!styles.every((style) => style !== null && typeof style === "object")) return undefined;
  const styleAt = (index: unknown): SurfaceBlockStyle | undefined =>
    Number.isInteger(index)
      ? (styles[index as number] as SurfaceBlockStyle | undefined)
      : undefined;
  const decodeFields = (value: Plain, keys: ReadonlySet<string>): Plain | undefined => {
    const output: Plain = {};
    for (const key of Object.keys(value)) {
      if (!keys.has(key)) return undefined;
      const field = value[key];
      if (STYLE_KEYS.has(key)) {
        const style = styleAt(field);
        if (style === undefined) return undefined;
        output[key] = style;
      } else output[key] = field;
    }
    return output;
  };
  const surface: (SurfaceBlock | undefined)[] = [];
  for (const column of columns as unknown[]) {
    if (column === null) {
      surface.push(undefined);
      continue;
    }
    if (typeof column !== "object" || Array.isArray(column)) return undefined;
    const block = decodeFields(column as Plain, COLUMN_KEYS);
    if (block === undefined || typeof block.name !== "string" || !isExactNumber(block.y))
      return undefined;
    if (block.shadowRuns !== undefined) {
      const flat = block.shadowRuns;
      if (!Array.isArray(flat) || flat.length % 3 !== 0 || !flat.every(isExactNumber))
        return undefined;
      const runs: ShadowOpacityRun[] = [];
      for (let index = 0; index < flat.length; index += 3) {
        runs.push({ minY: flat[index]!, maxY: flat[index + 1]!, opacity: flat[index + 2]! });
      }
      block.shadowRuns = runs;
    }
    if (block.colorLayers !== undefined) {
      if (!Array.isArray(block.colorLayers)) return undefined;
      const layers: SurfaceColorLayer[] = [];
      for (const layer of block.colorLayers as unknown[]) {
        if (layer === null || typeof layer !== "object" || Array.isArray(layer)) return undefined;
        const value = decodeFields(layer as Plain, LAYER_KEYS);
        if (value === undefined || typeof value.name !== "string" || !isExactNumber(value.count))
          return undefined;
        layers.push(value as unknown as SurfaceColorLayer);
      }
      block.colorLayers = layers;
    }
    surface.push(block as unknown as SurfaceBlock);
  }
  return surface;
}

/** A surface extracted without biome records equals the biome-scoped one without biome IDs. */
function withoutBiomes(surface: ChunkSurface): ChunkSurface {
  return surface.map((column) => {
    if (column?.biomeId === undefined) return column;
    const { biomeId: _biomeId, ...rest } = column;
    return rest;
  });
}

function isExactNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}

function exactJson(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return isExactNumber(value);
  if (Array.isArray(value)) return value.every(exactJson);
  if (value === null || typeof value !== "object") return false;
  return Object.values(value).every((field) => field !== undefined && exactJson(field));
}

// ---------------------------------------------------------------------------------------------
// Pack files

interface PackEntry {
  readonly x: number;
  readonly z: number;
  readonly scoped: boolean;
  readonly fingerprint: string;
  readonly blob: Uint8Array;
}

interface ParsedPack {
  readonly dimension: number;
  readonly config: string;
  readonly entries: Map<string, PackEntry>;
}

export function encodeSurfacePack(
  dimension: number,
  config: string,
  entries: Iterable<PackEntry>,
): Uint8Array {
  const rows = [...entries].sort(
    (a, b) => a.x - b.x || a.z - b.z || Number(a.scoped) - Number(b.scoped),
  );
  const encoder = new TextEncoder();
  const fingerprints = rows.map((row) => encoder.encode(row.fingerprint));
  let size = HEADER_BYTES;
  for (const [index, row] of rows.entries()) {
    if (fingerprints[index]!.byteLength > 255) throw new RangeError("Fingerprint too long");
    size += 14 + fingerprints[index]!.byteLength + row.blob.byteLength;
  }
  const bytes = new Uint8Array(size + DIGEST_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, PACK_MAGIC, true);
  view.setUint32(4, SURFACE_PACK_VERSION, true);
  view.setInt32(8, dimension, true);
  bytes.set(Buffer.from(config, "hex"), 12);
  view.setUint32(44, rows.length, true);
  let offset = HEADER_BYTES;
  for (const [index, row] of rows.entries()) {
    const fingerprint = fingerprints[index]!;
    view.setInt32(offset, row.x, true);
    view.setInt32(offset + 4, row.z, true);
    bytes[offset + 8] = row.scoped ? 1 : 0;
    bytes[offset + 9] = fingerprint.byteLength;
    view.setUint32(offset + 10, row.blob.byteLength, true);
    bytes.set(fingerprint, offset + 14);
    offset += 14 + fingerprint.byteLength;
    bytes.set(row.blob, offset);
    offset += row.blob.byteLength;
  }
  bytes.set(createHash("sha256").update(bytes.subarray(0, size)).digest(), size);
  return bytes;
}

/** Parses and verifies a pack; returns undefined for any damaged or foreign pack. */
export function parseSurfacePack(
  bytes: Uint8Array,
  expected?: { readonly dimension: number; readonly config: string },
): ParsedPack | undefined {
  if (bytes.byteLength < HEADER_BYTES + DIGEST_BYTES) return undefined;
  const size = bytes.byteLength - DIGEST_BYTES;
  const digest = createHash("sha256").update(bytes.subarray(0, size)).digest();
  if (!digest.equals(bytes.subarray(size))) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== PACK_MAGIC || view.getUint32(4, true) !== SURFACE_PACK_VERSION)
    return undefined;
  const dimension = view.getInt32(8, true);
  const config = Buffer.from(bytes.subarray(12, 44)).toString("hex");
  if (expected !== undefined && (expected.dimension !== dimension || expected.config !== config))
    return undefined;
  const count = view.getUint32(44, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, PackEntry>();
  let offset = HEADER_BYTES;
  for (let index = 0; index < count; index += 1) {
    if (offset + 14 > size) return undefined;
    const x = view.getInt32(offset, true);
    const z = view.getInt32(offset + 4, true);
    const scoped = bytes[offset + 8] === 1;
    const fingerprintLength = bytes[offset + 9]!;
    const blobLength = view.getUint32(offset + 10, true);
    const end = offset + 14 + fingerprintLength + blobLength;
    if (end > size) return undefined;
    const fingerprint = decoder.decode(
      bytes.subarray(offset + 14, offset + 14 + fingerprintLength),
    );
    entries.set(entryKey(x, z, scoped), {
      x,
      z,
      scoped,
      fingerprint,
      blob: bytes.subarray(offset + 14 + fingerprintLength, end),
    });
    offset = end;
  }
  if (offset !== size) return undefined;
  return { dimension, config, entries };
}

/** Rejects links (including Windows junctions) on every component from `root` to `path`. */
async function assertPlainPath(root: string, parts: readonly string[], leaf: "file" | "directory") {
  let current = root;
  for (const [index, part] of ["", ...parts].entries()) {
    if (part !== "") current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink())
      throw new Error(`Symbolic links and junctions are not supported: ${current}`);
    const last = index === parts.length;
    if (!last || leaf === "directory") {
      if (!stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    } else if (!stat.isFile()) throw new Error(`Not a file: ${current}`);
  }
}

function isMissing(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

// ---------------------------------------------------------------------------------------------
// Renderer-side reader

/**
 * Reads verified packs for one renderer and encodes the surfaces it extracts. Writes are never
 * made here: entries are drained and handed to the single {@link SurfaceStoreWriter}.
 */
export class SurfaceStoreReader {
  readonly stats = { hits: 0, stored: 0, rejected: 0 };
  private readonly packs = new Map<string, { pack: ParsedPack | undefined; bytes: number }>();
  private packBytes = 0;
  private readonly budget: number;
  private pending: StoredSurfaceEntry[] = [];

  constructor(budgetMiB = 64) {
    this.budget = Math.floor(budgetMiB * MIB);
  }

  async lookup(
    job: SurfaceStoreJob,
    chunkX: number,
    chunkZ: number,
    scoped: boolean,
    signal?: AbortSignal,
  ): Promise<ChunkSurface | undefined> {
    const fingerprint = job.fingerprints.get(`${chunkX},${chunkZ}`);
    if (fingerprint === undefined) return undefined;
    const pack = await this.pack(job, surfacePackName(chunkX, chunkZ), signal);
    if (pack === undefined) return undefined;
    let entry = pack.entries.get(entryKey(chunkX, chunkZ, scoped));
    let strip = false;
    if ((entry === undefined || entry.fingerprint !== fingerprint) && !scoped) {
      entry = pack.entries.get(entryKey(chunkX, chunkZ, true));
      strip = true;
    }
    if (entry === undefined || entry.fingerprint !== fingerprint) return undefined;
    const surface = decodeChunkSurface(entry.blob);
    if (surface === undefined) {
      this.stats.rejected += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return strip ? withoutBiomes(surface) : surface;
  }

  record(
    job: SurfaceStoreJob,
    chunkX: number,
    chunkZ: number,
    scoped: boolean,
    surface: ChunkSurface,
  ): void {
    const fingerprint = job.fingerprints.get(`${chunkX},${chunkZ}`);
    if (fingerprint === undefined) return;
    const blob = encodeChunkSurface(surface);
    if (blob === undefined) return;
    this.stats.stored += 1;
    this.pending.push({
      directory: job.directory,
      config: job.config,
      dimension: job.dimension,
      x: chunkX,
      z: chunkZ,
      scoped,
      fingerprint,
      blob,
    });
  }

  drain(): StoredSurfaceEntry[] {
    const entries = this.pending;
    this.pending = [];
    return entries;
  }

  drainStats(): { hits: number; stored: number; rejected: number } {
    const stats = { ...this.stats };
    this.stats.hits = 0;
    this.stats.stored = 0;
    this.stats.rejected = 0;
    return stats;
  }

  private async pack(
    job: SurfaceStoreJob,
    name: string,
    signal?: AbortSignal,
  ): Promise<ParsedPack | undefined> {
    const key = join(job.directory, name);
    const cached = this.packs.get(key);
    if (cached !== undefined) {
      this.packs.delete(key);
      this.packs.set(key, cached);
      return cached.pack;
    }
    let pack: ParsedPack | undefined;
    let bytes = 0;
    try {
      const path = join(job.directory, name);
      await assertPlainPath(job.directory, [name], "file");
      const data = await readFile(path, { signal });
      bytes = data.byteLength;
      pack = parseSurfacePack(data, { dimension: job.dimension, config: job.config });
      if (pack === undefined) this.stats.rejected += 1;
    } catch (cause) {
      signal?.throwIfAborted();
      if (!isMissing(cause)) this.stats.rejected += 1;
    }
    this.packs.set(key, { pack, bytes });
    this.packBytes += bytes;
    for (const [oldest, entry] of this.packs) {
      if (this.packBytes <= this.budget) break;
      this.packs.delete(oldest);
      this.packBytes -= entry.bytes;
    }
    return pack;
  }
}

// ---------------------------------------------------------------------------------------------
// Single writer

export interface SurfaceStoreWriterOptions {
  /** Existing store root owned by the caller; links below it are rejected. */
  readonly root: string;
  /** Caller identity (renderer revision and settings); other namespaces are removed on flush. */
  readonly namespace: string;
  readonly maxBytes: number;
}

/**
 * Collects encoded surfaces and rewrites the affected packs once, at the end of a session. Flush
 * also drops entries whose chunk changed or disappeared, removes other namespaces and evicts the
 * oldest packs until the store fits `maxBytes`.
 */
export class SurfaceStoreWriter {
  readonly stats = createSurfaceStoreStats();
  readonly namespaceDirectory: string;
  private readonly root: string;
  readonly namespaceName: string;
  private readonly maxBytes: number;
  private readonly pending = new Map<string, Map<string, StoredSurfaceEntry>>();
  private pendingBytes = 0;

  constructor(options: SurfaceStoreWriterOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes;
    this.namespaceName = surfaceStoreDigest(options.namespace).slice(0, 32);
    this.namespaceDirectory = join(this.root, this.namespaceName);
  }

  /** Config directory for one dimension, surface range and surface style digest. */
  configDirectory(config: string): string {
    return join(this.namespaceDirectory, config.slice(0, 32));
  }

  add(entries: readonly StoredSurfaceEntry[]): void {
    for (const entry of entries) {
      if (this.pendingBytes + entry.blob.byteLength > this.maxBytes) return;
      const pack = join(entry.directory, surfacePackName(entry.x, entry.z));
      const rows = this.pending.get(pack) ?? new Map<string, StoredSurfaceEntry>();
      this.pending.set(pack, rows);
      const key = entryKey(entry.x, entry.z, entry.scoped);
      if (rows.has(key)) continue;
      rows.set(key, entry);
      this.pendingBytes += entry.blob.byteLength;
    }
  }

  async flush(
    currentFingerprints: (dimension: number) => ReadonlyMap<string, string> | undefined,
  ): Promise<SurfaceStoreStats> {
    const byDimension = new Map<number, ReadonlyMap<string, string> | undefined>();
    const fingerprints = (dimension: number): ReadonlyMap<string, string> | undefined => {
      if (!byDimension.has(dimension)) byDimension.set(dimension, currentFingerprints(dimension));
      return byDimension.get(dimension);
    };
    await assertPlainPath(this.root, [], "directory");
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (entry.name === this.namespaceName) continue;
      await this.removeTree([entry.name]);
    }
    await mkdir(this.namespaceDirectory, { recursive: true });
    await assertPlainPath(this.root, [this.namespaceName], "directory");

    const configs = new Set<string>();
    for (const entry of await readdir(this.namespaceDirectory, { withFileTypes: true })) {
      if (DIGEST_NAME.test(entry.name) && entry.isDirectory() && !entry.isSymbolicLink())
        configs.add(entry.name);
      else await this.removeTree([this.namespaceName, entry.name]);
    }
    const pendingByConfig = new Map<string, Map<string, Map<string, StoredSurfaceEntry>>>();
    for (const [pack, rows] of this.pending) {
      const first = rows.values().next().value!;
      const config = first.config.slice(0, 32);
      if (join(this.namespaceDirectory, config) !== first.directory) continue;
      configs.add(config);
      const packs = pendingByConfig.get(config) ?? new Map();
      packs.set(pack.slice(first.directory.length + 1), rows);
      pendingByConfig.set(config, packs);
    }

    const files: { parts: string[]; bytes: number; order: number }[] = [];
    let order = 0;
    for (const config of [...configs].sort()) {
      const directory = join(this.namespaceDirectory, config);
      await mkdir(directory, { recursive: true });
      await assertPlainPath(this.root, [this.namespaceName, config], "directory");
      const pending = pendingByConfig.get(config) ?? new Map();
      const names = new Set<string>(pending.keys());
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (PACK_NAME.test(entry.name) && entry.isFile()) names.add(entry.name);
        else await this.removeTree([this.namespaceName, config, entry.name]);
      }
      for (const name of [...names].sort()) {
        const parts = [this.namespaceName, config, name];
        const fresh = pending.get(name);
        const written = await this.rewritePack(parts, fresh, fingerprints);
        if (written > 0)
          files.push({ parts, bytes: written, order: fresh === undefined ? 0 : ++order });
      }
    }

    // Keep the newest packs (those written now) when the store exceeds its bound.
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of files.sort((a, b) => a.order - b.order)) {
      if (total <= this.maxBytes) break;
      await this.removeFile(file.parts);
      total -= file.bytes;
      this.stats.removedPacks += 1;
    }
    this.stats.totalBytes = total;
    this.pending.clear();
    this.pendingBytes = 0;
    return this.stats;
  }

  /** Returns the pack size kept on disk, or 0 when the pack was removed. */
  private async rewritePack(
    parts: string[],
    fresh: ReadonlyMap<string, StoredSurfaceEntry> | undefined,
    fingerprints: (dimension: number) => ReadonlyMap<string, string> | undefined,
  ): Promise<number> {
    const path = join(this.root, ...parts);
    let existing: ParsedPack | undefined;
    let existingBytes = 0;
    try {
      await assertPlainPath(this.root, parts, "file");
      const data = await readFile(path);
      existingBytes = data.byteLength;
      existing = parseSurfacePack(data);
      if (existing !== undefined && existing.config.slice(0, 32) !== parts[1]) existing = undefined;
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
    const first = fresh?.values().next().value;
    const dimension = first?.dimension ?? existing?.dimension;
    const config = first?.config ?? existing?.config;
    const current = dimension === undefined ? undefined : fingerprints(dimension);
    const rows = new Map<string, PackEntry>();
    let dropped = existing === undefined && existingBytes > 0;
    if (existing !== undefined && existing.config === config) {
      for (const [key, entry] of existing.entries) {
        if (current?.get(`${entry.x},${entry.z}`) === entry.fingerprint) rows.set(key, entry);
        else dropped = true;
      }
    } else if (existing !== undefined) dropped = true;
    let added = false;
    for (const [key, entry] of fresh ?? []) {
      if (current?.get(`${entry.x},${entry.z}`) !== entry.fingerprint) continue;
      const previous = rows.get(key);
      if (previous?.fingerprint === entry.fingerprint) continue;
      rows.set(key, entry);
      added = true;
    }
    // The biome-free variant is derived from the scoped one, so it is redundant next to it.
    for (const [key, entry] of rows) {
      if (entry.scoped) continue;
      if (rows.get(entryKey(entry.x, entry.z, true))?.fingerprint !== entry.fingerprint) continue;
      rows.delete(key);
      dropped = true;
    }
    if (!added && !dropped) return existingBytes;
    if (rows.size === 0 || dimension === undefined || config === undefined) {
      if (existingBytes > 0 || existing !== undefined) {
        await this.removeFile(parts);
        this.stats.removedPacks += 1;
      }
      return 0;
    }
    const bytes = encodeSurfacePack(dimension, config, rows.values());
    const temporary = [...parts.slice(0, -1), `.${randomUUID()}.tmp`];
    await assertPlainPath(this.root, parts.slice(0, -1), "directory");
    await writeFile(join(this.root, ...temporary), bytes, { flag: "wx" });
    await rename(join(this.root, ...temporary), path);
    this.stats.writtenBytes += bytes.byteLength;
    return bytes.byteLength;
  }

  private async removeFile(parts: readonly string[]): Promise<void> {
    await assertPlainPath(this.root, parts, "file");
    await unlink(join(this.root, ...parts));
  }

  /** Removes a tree below the root after checking that it contains no link. */
  private async removeTree(parts: readonly string[]): Promise<void> {
    const visit = async (current: readonly string[]): Promise<void> => {
      const stat = await lstat(join(this.root, ...current));
      if (stat.isSymbolicLink())
        throw new Error(
          `Symbolic links and junctions are not supported: ${join(this.root, ...current)}`,
        );
      if (!stat.isDirectory()) return;
      for (const entry of await readdir(join(this.root, ...current))) {
        await visit([...current, entry]);
      }
    };
    await assertPlainPath(this.root, parts.slice(0, -1), "directory");
    await visit(parts);
    await rm(join(this.root, ...parts), { recursive: true, force: true });
  }
}
