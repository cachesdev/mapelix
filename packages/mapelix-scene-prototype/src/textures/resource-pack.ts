import { createHash } from "node:crypto";

import { openPackFiles, packSubfolder, type PackFiles } from "./pack-files.js";
import {
  IMAGE_EXTENSIONS,
  decodePackImage,
  packImageSize,
  parsePackJson,
  type PackImage,
} from "./pack-image.js";
import { ResourcePackError, packLimits, type PackLimits } from "./pack-limits.js";
import { readStackFile } from "./stack-file.js";

/** What a pack says about itself in `manifest.json`, for the host to show. */
export interface ResourcePackInfo {
  readonly name: string;
  readonly version: string;
  readonly uuid: string;
}

/** One texture of a `terrain_texture.json` entry; paths have no extension. */
export interface TextureRef {
  readonly path: string;
  /** `overlay_color` or `tint_color`, packed `0xRRGGBB`. */
  readonly color?: number;
}

/** A `terrain_texture.json` entry: one texture, or several indexed by a legacy data value. */
export interface TerrainEntry {
  readonly textures: readonly TextureRef[];
}

export type BlockFace = "up" | "down" | "north" | "south" | "east" | "west";
export const BLOCK_FACES: readonly BlockFace[] = ["up", "down", "north", "south", "east", "west"];

/** Terrain texture names of a `blocks.json` entry, per face. */
export type BlockTextureNames = Readonly<Record<BlockFace, string>>;

/** A `flipbook_textures.json` animation of one terrain texture. */
export interface Flipbook {
  readonly path: string;
  readonly ticksPerFrame: number;
  /** Frame order as indexes into the image's square frames; absent means in order. */
  readonly frames?: readonly number[];
  readonly blendFrames: boolean;
}

export interface ResourcePack {
  readonly info: ResourcePackInfo;
  readonly files: PackFiles;
  readonly terrain: ReadonlyMap<string, TerrainEntry>;
  readonly blocks: ReadonlyMap<string, BlockTextureNames>;
  readonly flipbooks: ReadonlyMap<string, Flipbook>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function color(value: unknown): number | undefined {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
    ? Number.parseInt(value.slice(1), 16)
    : undefined;
}

/** Opens one pack: a folder, or a zip or `.mcpack` file, with the pack at its root or one level down. */
export async function openResourcePack(source: string, limits: PackLimits): Promise<ResourcePack> {
  const all = await openPackFiles(source, limits);
  const json = async (files: PackFiles, path: string): Promise<unknown> => {
    try {
      return parsePackJson(await files.read(path));
    } catch (error) {
      if (error instanceof ResourcePackError) throw error;
      throw new ResourcePackError(
        files.label,
        `is not valid JSON: ${(error as Error).message}`,
        path,
      );
    }
  };

  // A pack sits at the root, or alone in one top-level folder (as in a world or a sample archive).
  const candidates = [...all.sizes.keys()]
    .filter((path) => path === "manifest.json" || /^[^/]+\/manifest\.json$/.test(path))
    .sort((left, right) => left.length - right.length || (left < right ? -1 : 1));
  let root: string | undefined;
  let manifest: Record<string, unknown> | undefined;
  for (const path of candidates) {
    const parsed = record(await json(all, path));
    const modules = Array.isArray(parsed?.["modules"]) ? (parsed["modules"] as unknown[]) : [];
    if (!modules.some((module) => record(module)?.["type"] === "resources")) continue;
    const folder = path.slice(0, -"manifest.json".length).replace(/\/$/, "");
    if (root !== undefined) {
      if (root === "") break;
      throw new ResourcePackError(all.label, `holds several resource packs (${root}, ${folder})`);
    }
    root = folder;
    manifest = parsed;
  }
  if (root === undefined || manifest === undefined) {
    throw new ResourcePackError(
      all.label,
      "holds no resource pack: manifest.json with a resources module",
    );
  }
  const files = packSubfolder(all, root);

  const header = record(manifest["header"]);
  const name = header?.["name"];
  const uuid = header?.["uuid"];
  const version = header?.["version"];
  const versionText = Array.isArray(version)
    ? version.every((part) => Number.isSafeInteger(part) && (part as number) >= 0)
      ? version.join(".")
      : undefined
    : typeof version === "string"
      ? version
      : undefined;
  if (
    typeof name !== "string" ||
    typeof uuid !== "string" ||
    !UUID.test(uuid) ||
    versionText === undefined
  ) {
    throw new ResourcePackError(
      files.label,
      "has no header name, uuid or version",
      "manifest.json",
    );
  }
  const info = { name, version: versionText, uuid: uuid.toLowerCase() };

  const terrain = new Map<string, TerrainEntry>();
  if (files.sizes.has("textures/terrain_texture.json")) {
    const data = record(
      record(await json(files, "textures/terrain_texture.json"))?.["texture_data"],
    );
    for (const [key, value] of Object.entries(data ?? {})) {
      const textures = textureRefs(record(value)?.["textures"]);
      if (textures.length > 0) terrain.set(key, { textures });
    }
  }

  const blocks = new Map<string, BlockTextureNames>();
  if (files.sizes.has("blocks.json")) {
    for (const [key, value] of Object.entries(record(await json(files, "blocks.json")) ?? {})) {
      const faces = blockFaces(record(value)?.["textures"]);
      if (faces !== undefined) blocks.set(key.replace(/^minecraft:/, ""), faces);
    }
  }

  const flipbooks = new Map<string, Flipbook>();
  if (files.sizes.has("textures/flipbook_textures.json")) {
    const list = await json(files, "textures/flipbook_textures.json");
    for (const value of Array.isArray(list) ? list : []) {
      const entry = record(value);
      const tile = entry?.["atlas_tile"];
      const path = entry?.["flipbook_texture"];
      if (typeof tile !== "string" || typeof path !== "string") continue;
      const ticks = entry?.["ticks_per_frame"];
      const frames = entry?.["frames"];
      flipbooks.set(tile, {
        path,
        ticksPerFrame:
          typeof ticks === "number" && Number.isSafeInteger(ticks) && ticks >= 1 && ticks <= 1000
            ? ticks
            : 1,
        ...(Array.isArray(frames) &&
        frames.length > 0 &&
        frames.length <= 1024 &&
        frames.every((frame) => Number.isSafeInteger(frame) && frame >= 0 && frame < 1024)
          ? { frames: frames as number[] }
          : {}),
        blendFrames: entry?.["blend_frames"] !== false,
      });
    }
  }
  return { info, files, terrain, blocks, flipbooks };
}

function textureRefs(value: unknown): TextureRef[] {
  const one = (item: unknown): TextureRef | undefined => {
    if (typeof item === "string") return { path: item };
    const entry = record(item);
    if (entry === undefined) return undefined;
    const variations = entry["variations"];
    if (Array.isArray(variations)) return one(variations[0]);
    const path = entry["path"];
    if (typeof path !== "string") return undefined;
    const tint = color(entry["overlay_color"]) ?? color(entry["tint_color"]);
    return tint === undefined ? { path } : { path, color: tint };
  };
  const items = Array.isArray(value) ? value : [value];
  return items.slice(0, 64).flatMap((item) => {
    const ref = one(item);
    return ref === undefined ? [] : [ref];
  });
}

function blockFaces(value: unknown): BlockTextureNames | undefined {
  if (typeof value === "string") {
    return { up: value, down: value, north: value, south: value, east: value, west: value };
  }
  const faces = record(value);
  if (faces === undefined) return undefined;
  const name = (key: string): string | undefined =>
    typeof faces[key] === "string" ? (faces[key] as string) : undefined;
  const side = name("side");
  const any = name("up") ?? side ?? name("down") ?? name("north");
  if (any === undefined) return undefined;
  const horizontal = (key: string): string => name(key) ?? side ?? any;
  return {
    up: name("up") ?? side ?? any,
    down: name("down") ?? side ?? any,
    north: horizontal("north"),
    south: horizontal("south"),
    east: horizontal("east"),
    west: horizontal("west"),
  };
}

/** The version of the texture pipeline; part of every stack and pack fingerprint. */
export const TEXTURE_PIPELINE_VERSION = 2;

const PACK_JSON = [
  "manifest.json",
  "blocks.json",
  "textures/terrain_texture.json",
  "textures/flipbook_textures.json",
] as const;

/**
 * Names one pack's content: its manifest, its block JSON files and every PNG and TGA image it
 * holds. A host may pin it in `mapelix-stack.json`; `validateTextureStack` reports it.
 */
export async function packFingerprint(pack: ResourcePack): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`mapelix-texture-pack-v${TEXTURE_PIPELINE_VERSION}\n`);
  hash.update(`${pack.info.uuid}\0${pack.info.version}\0${pack.info.name}\n`);
  const paths = [...pack.files.sizes.keys()]
    .filter(
      (path) =>
        (PACK_JSON as readonly string[]).includes(path) ||
        IMAGE_EXTENSIONS.some((extension) => path.endsWith(extension)),
    )
    .sort();
  for (const path of paths) hash.update(`${path}\0${await pack.files.digest(path)}\n`);
  return hash.digest("hex").slice(0, 20);
}

/** Where a stack's packs come from: a stack folder with `mapelix-stack.json`, or a list. */
export type TextureStackSource = { readonly stack: string } | { readonly packs: readonly string[] };

/** Packs in priority order, as Bedrock stacks them: what the first lacks comes from the next. */
export interface ResourcePackStack {
  /** Highest priority first. */
  readonly packs: readonly ResourcePack[];
  /** Covers every pack, in order, and every file the textures can come from. */
  readonly fingerprint: string;
  terrainEntry(name: string): TerrainEntry | undefined;
  blockTextures(block: string): BlockTextureNames | undefined;
  flipbook(name: string): Flipbook | undefined;
  /** The pack and file an image path (no extension) resolves to. */
  locateImage(path: string): { readonly pack: ResourcePack; readonly file: string } | undefined;
  /** Reads only the header of the image at `path`. */
  readImageSize(
    path: string,
  ): Promise<{ readonly width: number; readonly height: number } | undefined>;
  /** Decodes the image at `path` (no extension) from the first pack holding it. */
  readImage(path: string): Promise<PackImage | undefined>;
}

export async function openResourcePackStack(
  source: TextureStackSource | readonly string[],
  overrides: Partial<PackLimits> = {},
): Promise<ResourcePackStack> {
  const limits = packLimits(overrides);
  const entries =
    "stack" in source
      ? await readStackFile(source.stack, limits)
      : ("packs" in source ? source.packs : (source as readonly string[])).map((path) => ({
          source: path,
        }));
  if (entries.length === 0) throw new RangeError("A resource pack stack needs at least one pack");
  if (entries.length > limits.maxPacks) {
    throw new RangeError(`A resource pack stack holds at most ${limits.maxPacks} packs`);
  }
  const packs: ResourcePack[] = [];
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const pack = await openResourcePack(entry.source, limits);
    files += pack.files.sizes.size;
    for (const size of pack.files.sizes.values()) bytes += size;
    if (files > limits.maxStackEntries) {
      throw new ResourcePackError(
        pack.files.label,
        `brings the stack over ${limits.maxStackEntries} files`,
      );
    }
    if (bytes > limits.maxStackBytes) {
      throw new ResourcePackError(
        pack.files.label,
        `brings the stack over ${limits.maxStackBytes} bytes`,
      );
    }
    if ("uuid" in entry) {
      const listed = entry as { uuid: string; version: string; fingerprint?: string; path: string };
      if (pack.info.uuid !== listed.uuid || pack.info.version !== listed.version) {
        throw new ResourcePackError(
          pack.files.label,
          `is ${pack.info.uuid} ${pack.info.version}, but mapelix-stack.json lists ${listed.uuid} ${listed.version}`,
        );
      }
      if (listed.fingerprint !== undefined) {
        const actual = await packFingerprint(pack);
        if (actual !== listed.fingerprint) {
          throw new ResourcePackError(
            pack.files.label,
            `has fingerprint ${actual}, but mapelix-stack.json pins ${listed.fingerprint}`,
          );
        }
      }
    }
    packs.push(pack);
  }

  const first = <T>(lookup: (pack: ResourcePack) => T | undefined): T | undefined => {
    for (const pack of packs) {
      const found = lookup(pack);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const locate = (path: string): { pack: ResourcePack; file: string } | undefined =>
    first((pack) => {
      for (const extension of IMAGE_EXTENSIONS) {
        const file = `${path}${extension}`;
        if (pack.files.sizes.has(file)) return { pack, file };
      }
      return undefined;
    });

  const hash = createHash("sha256");
  hash.update(`mapelix-texture-stack-v${TEXTURE_PIPELINE_VERSION}\n`);
  for (const pack of packs) {
    hash.update(`pack\0${pack.info.uuid}\0${pack.info.version}\0${pack.info.name}\n`);
    for (const path of PACK_JSON) {
      if (pack.files.sizes.has(path)) hash.update(`${path}\0${await pack.files.digest(path)}\n`);
    }
  }
  // Every image the merged stack can use: a terrain entry or flipbook comes from the first pack
  // defining it, its image file from the first pack holding that path.
  const images = new Set<string>();
  const terrainNames = new Set(packs.flatMap((pack) => [...pack.terrain.keys()]));
  for (const name of terrainNames) {
    const entry = first((pack) => pack.terrain.get(name))!;
    for (const texture of entry.textures) images.add(texture.path);
  }
  const flipbookNames = new Set(packs.flatMap((pack) => [...pack.flipbooks.keys()]));
  for (const name of flipbookNames) images.add(first((pack) => pack.flipbooks.get(name))!.path);
  for (const path of [...images].sort()) {
    const found = locate(path);
    hash.update(
      found === undefined
        ? `${path}\0missing\n`
        : `${path}\0${found.pack.info.uuid}\0${found.file}\0${await found.pack.files.digest(found.file)}\n`,
    );
  }
  const fingerprint = hash.digest("hex").slice(0, 20);

  const imageError = (found: { pack: ResourcePack; file: string }, error: unknown): never => {
    if (error instanceof ResourcePackError) throw error;
    throw new ResourcePackError(found.pack.files.label, (error as Error).message, found.file);
  };
  return {
    packs,
    fingerprint,
    terrainEntry: (name) => first((pack) => pack.terrain.get(name)),
    blockTextures: (block) => first((pack) => pack.blocks.get(block.replace(/^minecraft:/, ""))),
    flipbook: (name) => first((pack) => pack.flipbooks.get(name)),
    locateImage: locate,
    readImageSize: async (path) => {
      const found = locate(path);
      if (found === undefined) return undefined;
      try {
        return packImageSize(await found.pack.files.read(found.file), found.file, limits);
      } catch (error) {
        return imageError(found, error);
      }
    },
    readImage: async (path) => {
      const found = locate(path);
      if (found === undefined) return undefined;
      try {
        return decodePackImage(await found.pack.files.read(found.file), found.file, limits);
      } catch (error) {
        return imageError(found, error);
      }
    },
  };
}
