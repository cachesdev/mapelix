import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createSceneHandler, createSceneServer } from "@mapelix/viewer/node";
import { createTexturePacks, DEFAULT_VANILLA_PACK_URL, storedTextureStack } from "./texture-packs";

function positive(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer, received ${raw}`);
  return value;
}

const directory = process.env.MAPELIX_WORLD_DIRECTORY;
const cacheDirectory =
  process.env.MAPELIX_CACHE_DIRECTORY ?? join(tmpdir(), "mapelix-demo-scene-cache");

/**
 * The pack stack the demo may change while it runs (`MAPELIX_TEXTURE_UPLOADS=1`): packs uploaded
 * or downloaded at `/textures`, kept in `MAPELIX_TEXTURE_PACK_DIRECTORY`.
 * `MAPELIX_TEXTURE_VANILLA=1` downloads the vanilla pack when the demo starts without a stack.
 */
const uploads = process.env.MAPELIX_TEXTURE_UPLOADS === "1";
const vanillaOnStart = process.env.MAPELIX_TEXTURE_VANILLA === "1";
const managed = uploads || vanillaOnStart;
const packDirectory =
  process.env.MAPELIX_TEXTURE_PACK_DIRECTORY ?? join(cacheDirectory, "texture-packs");

/**
 * Block textures: a stack folder with its `mapelix-stack.json`, or a list of packs separated
 * by the platform path delimiter, highest priority first. Without either the world keeps its
 * block colors, or the stack chosen last at `/textures`.
 */
const textureStack = process.env.MAPELIX_TEXTURE_STACK;
const texturePacks = process.env.MAPELIX_TEXTURE_PACKS?.split(delimiter).filter((path) => path);
const storedPacks = managed ? storedTextureStack(packDirectory) : [];
const textures =
  textureStack !== undefined && textureStack !== ""
    ? { textures: { stack: textureStack } }
    : texturePacks !== undefined && texturePacks.length > 0
      ? { textures: { packs: texturePacks } }
      : storedPacks.length > 0
        ? { textures: { packs: storedPacks.map((entry) => join(packDirectory, entry.file)) } }
        : {};

/** True when a world folder is configured: the map then turns into the 3D world when zoomed in. */
export const hasWorld = directory !== undefined && directory !== "";
const worldDirectory = directory ?? "";

const server = hasWorld
  ? createSceneServer({
      worldDirectory,
      cacheDirectory,
      workers: positive("MAPELIX_SCENE_WORKERS", 1),
      caveMemoryMiB: positive("MAPELIX_CAVE_MEMORY_MIB", 16),
      discoveryMemoryMiB: positive("MAPELIX_DISCOVERY_MEMORY_MIB", 4),
      ...textures,
    })
  : undefined;

/** Serves the 3D endpoints of `MAPELIX_WORLD_DIRECTORY` below `/world` (the world is only read). */
export const handleWorld = server === undefined ? undefined : createSceneHandler(server, "/world");

const packs =
  server !== undefined && managed
    ? createTexturePacks(server, {
        directory: packDirectory,
        maxBytes: positive("MAPELIX_TEXTURE_PACK_MIB", 256) * 1024 * 1024,
        vanillaUrl: process.env.MAPELIX_VANILLA_PACK_URL ?? DEFAULT_VANILLA_PACK_URL,
      })
    : undefined;

/** True when `/textures` lets visitors change the pack stack. */
export const textureUploads = uploads && packs !== undefined;

/** The demo's pack page API at `/demo/textures`, with `MAPELIX_TEXTURE_UPLOADS=1` only. */
export const handleTexturePacks = textureUploads ? packs!.handler("/demo/textures") : undefined;

if (packs !== undefined && vanillaOnStart && !("textures" in textures)) {
  packs.vanilla().then(
    (report) => {
      if (!report.ok) console.warn(`The vanilla pack was refused: ${report.errors.join("; ")}`);
    },
    (cause: unknown) => console.warn(cause),
  );
}
