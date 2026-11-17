import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ATLAS_FORMAT_VERSION,
  buildTextureAtlas,
  decodeTextureAtlas,
  openResourcePackStack,
  type ResourcePackInfo,
  type TextureIndex,
} from "@mapelix/scene-prototype/textures";

/** The block textures of a resource pack stack, ready to serve and to build regions with. */
export interface SceneTextures {
  /** Names the atlas and every textured region; changes with any pack, its order or the layout. */
  readonly fingerprint: string;
  /** The packs, highest priority first, as their manifests describe them. */
  readonly packs: readonly ResourcePackInfo[];
  readonly tileSize: number;
  readonly tiles: number;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
  /** The encoded atlas, served as is. */
  readonly bytes: Uint8Array;
  readonly index: TextureIndex;
}

export interface SceneTextureOptions {
  readonly maxTileSize: number;
  readonly budgetBytes: number;
}

type Event = (name: string, detail: Record<string, unknown>) => void;

/**
 * Opens the stack and returns its atlas from `<cache>/textures-v<n>/<key>/`, or builds and stores
 * it. The key covers the stack fingerprint and the options; other keys are removed.
 */
export async function loadSceneTextures(
  packs: readonly string[],
  cacheDirectory: string,
  options: SceneTextureOptions,
  event: Event,
): Promise<SceneTextures> {
  const startedAt = performance.now();
  const stack = await openResourcePackStack(packs);
  const info = stack.packs.map((pack) => pack.info);
  const key = createHash("sha256")
    .update(`${stack.fingerprint}\0${options.maxTileSize}\0${options.budgetBytes}`)
    .digest("hex")
    .slice(0, 20);
  const root = join(cacheDirectory, `textures-v${ATLAS_FORMAT_VERSION}`);
  const folder = join(root, key);

  for (const entry of await readdir(root).catch(() => [] as string[])) {
    if (entry !== key) {
      await rm(join(root, entry), { recursive: true, force: true });
      event("textures.cache-removed", { key: entry });
    }
  }

  const stored = await readStored(folder).catch(() => undefined);
  if (stored !== undefined) {
    event("textures.cache-hit", {
      fingerprint: stored.index.fingerprint,
      milliseconds: Math.round(performance.now() - startedAt),
    });
    return { ...stored, packs: info };
  }

  const built = await buildTextureAtlas(stack, options);
  await mkdir(folder, { recursive: true });
  for (const [name, content] of [
    ["atlas.bin", built.bytes],
    ["index.json", JSON.stringify(built.index)],
  ] as const) {
    const temporary = join(folder, `${name}.${process.pid}.tmp`);
    await writeFile(temporary, content);
    await rename(temporary, join(folder, name));
  }
  event("textures.built", {
    fingerprint: built.fingerprint,
    tileSize: built.atlas.tileSize,
    tiles: built.atlas.tiles.length,
    gpuBytes: built.gpuBytes,
    milliseconds: Math.round(performance.now() - startedAt),
  });
  return {
    fingerprint: built.fingerprint,
    packs: info,
    tileSize: built.atlas.tileSize,
    tiles: built.atlas.tiles.length,
    gpuBytes: built.gpuBytes,
    bytes: built.bytes,
    index: built.index,
  };
}

async function readStored(folder: string): Promise<Omit<SceneTextures, "packs">> {
  const [bytes, indexText] = await Promise.all([
    readFile(join(folder, "atlas.bin")),
    readFile(join(folder, "index.json"), "utf8"),
  ]);
  const atlas = decodeTextureAtlas(
    new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
  const index = JSON.parse(indexText) as TextureIndex;
  if (typeof index.fingerprint !== "string" || !/^[0-9a-f]{20}$/.test(index.fingerprint)) {
    throw new Error("Stored texture index is damaged");
  }
  let gpuBytes = 0;
  for (const level of atlas.levels) gpuBytes += level.byteLength;
  return {
    fingerprint: index.fingerprint,
    tileSize: atlas.tileSize,
    tiles: atlas.tiles.length,
    gpuBytes,
    bytes: new Uint8Array(bytes),
    index,
  };
}
