import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

import {
  ATLAS_FORMAT_VERSION,
  buildTextureAtlas,
  decodeTextureAtlas,
  openResourcePackStack,
  packFingerprint,
  textureRevision,
  type PackLimits,
  type ResourcePackInfo,
  type ResourcePackStack,
  type TextureIndex,
  type TextureNotice,
  type TextureStackSource,
} from "@mapelix/scene-prototype/textures";

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

/** A built atlas, ready to serve and to build regions with. */
export interface SceneAtlas {
  readonly revision: string;
  readonly tileSize: number;
  readonly tiles: number;
  /** GPU bytes of the atlas with its mipmaps. */
  readonly gpuBytes: number;
  /** The encoded atlas and its gzip and Brotli encodings, served as they are. */
  readonly bytes: Uint8Array;
  readonly gzip: Uint8Array;
  readonly brotli: Uint8Array;
  readonly index: TextureIndex;
  readonly notices: readonly TextureNotice[];
}

export interface SceneTextureOptions {
  readonly maxTileSize: number;
  readonly budgetBytes: number;
  readonly limits?: Partial<PackLimits>;
}

type Event = (name: string, detail: Record<string, unknown>) => void;

const ATLAS_FILES = ["atlas.bin", "atlas.bin.gz", "atlas.bin.br", "index.json", "notices.json"];

/**
 * The textures of one resource pack stack. Opening reads the packs' JSON and names the texture
 * revision; the atlas is read from `<cache>/textures/atlas-v<n>/<revision>/` or built on first
 * use, once, and stored there. Other revisions are removed when the stack opens.
 */
export class SceneTextures {
  readonly revision: string;
  readonly packs: readonly ResourcePackInfo[];
  private readonly stack: ResourcePackStack;
  private readonly options: SceneTextureOptions;
  private readonly folder: string;
  private readonly event: Event;
  private atlas: SceneAtlas | undefined;
  private building: Promise<SceneAtlas> | undefined;
  private failure: string | undefined;

  private constructor(
    stack: ResourcePackStack,
    revision: string,
    folder: string,
    options: SceneTextureOptions,
    event: Event,
  ) {
    this.stack = stack;
    this.revision = revision;
    this.packs = stack.packs.map((pack) => pack.info);
    this.folder = folder;
    this.options = options;
    this.event = event;
  }

  static async open(
    source: TextureStackSource,
    cacheDirectory: string,
    options: SceneTextureOptions,
    event: Event,
  ): Promise<SceneTextures> {
    const stack = await openResourcePackStack(source, options.limits);
    const revision = textureRevision(stack.fingerprint, options);
    const root = join(cacheDirectory, "textures", `atlas-v${ATLAS_FORMAT_VERSION}`);
    for (const entry of await readdir(root).catch(() => [] as string[])) {
      if (entry !== revision) {
        await rm(join(root, entry), { recursive: true, force: true });
        event("textures.cache-removed", { revision: entry });
      }
    }
    const textures = new SceneTextures(stack, revision, join(root, revision), options, event);
    const startedAt = performance.now();
    textures.atlas = await readStored(textures.folder, revision).catch(() => undefined);
    if (textures.atlas !== undefined) {
      event("textures.cache-hit", {
        revision,
        milliseconds: Math.round(performance.now() - startedAt),
      });
    }
    return textures;
  }

  /** The atlas once built or read, without building it. */
  get ready(): SceneAtlas | undefined {
    return this.atlas;
  }

  /** Why the last build failed, until one succeeds. */
  get error(): string | undefined {
    return this.failure;
  }

  /** The atlas, built once when it is not stored; `cacheOnly` never builds. */
  async load(cacheOnly = false): Promise<SceneAtlas | undefined> {
    if (this.atlas !== undefined || cacheOnly) return this.atlas;
    this.building ??= this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async build(): Promise<SceneAtlas> {
    const startedAt = performance.now();
    try {
      const built = await buildTextureAtlas(this.stack, this.options);
      const [gzipped, brotli] = await Promise.all([
        gzipAsync(built.bytes, { level: 9 }),
        brotliAsync(built.bytes, {
          params: {
            [constants.BROTLI_PARAM_QUALITY]: 9,
            [constants.BROTLI_PARAM_SIZE_HINT]: built.bytes.byteLength,
          },
        }),
      ]);
      const atlas: SceneAtlas = {
        revision: built.fingerprint,
        tileSize: built.atlas.tileSize,
        tiles: built.atlas.tiles.length,
        gpuBytes: built.gpuBytes,
        bytes: built.bytes,
        gzip: new Uint8Array(gzipped),
        brotli: new Uint8Array(brotli),
        index: built.index,
        notices: built.notices,
      };
      await mkdir(this.folder, { recursive: true });
      const contents = [
        atlas.bytes,
        atlas.gzip,
        atlas.brotli,
        JSON.stringify(atlas.index),
        JSON.stringify(atlas.notices),
      ];
      for (const [index, name] of ATLAS_FILES.entries()) {
        const temporary = join(this.folder, `${name}.${process.pid}.tmp`);
        await writeFile(temporary, contents[index]!);
        await rename(temporary, join(this.folder, name));
      }
      this.atlas = atlas;
      this.failure = undefined;
      this.event("textures.built", {
        revision: atlas.revision,
        tileSize: atlas.tileSize,
        tiles: atlas.tiles,
        gpuBytes: atlas.gpuBytes,
        bytes: atlas.bytes.byteLength,
        brotliBytes: atlas.brotli.byteLength,
        gzipBytes: atlas.gzip.byteLength,
        milliseconds: Math.round(performance.now() - startedAt),
      });
      return atlas;
    } catch (cause) {
      this.failure = cause instanceof Error ? cause.message : String(cause);
      this.event("textures.failed", { message: this.failure });
      throw cause;
    }
  }
}

async function readStored(folder: string, revision: string): Promise<SceneAtlas> {
  const [bytes, gzipped, brotli, indexText, noticesText] = await Promise.all(
    ATLAS_FILES.map((name) => readFile(join(folder, name))),
  );
  const view = new Uint8Array(bytes!.buffer, bytes!.byteOffset, bytes!.byteLength);
  const atlas = decodeTextureAtlas(view);
  const index = JSON.parse(indexText!.toString("utf8")) as TextureIndex;
  if (index.fingerprint !== revision) throw new Error("Stored texture index is damaged");
  return {
    revision,
    tileSize: atlas.tileSize,
    tiles: atlas.tiles.length,
    gpuBytes: atlas.levels.reduce((sum, level) => sum + level.byteLength, 0),
    bytes: view,
    gzip: new Uint8Array(gzipped!),
    brotli: new Uint8Array(brotli!),
    index,
    notices: JSON.parse(noticesText!.toString("utf8")) as TextureNotice[],
  };
}

/** What `validateTextureStack` finds. */
export interface TextureStackReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** The texture revision a server would serve with the same options. */
  readonly revision?: string;
  readonly stackFingerprint?: string;
  /** Each pack with the fingerprint `mapelix-stack.json` may pin. */
  readonly packs?: readonly (ResourcePackInfo & { readonly fingerprint: string })[];
  readonly atlas?: {
    readonly tileSize: number;
    readonly tiles: number;
    readonly gpuBytes: number;
    readonly bytes: number;
    readonly gzipBytes: number;
    readonly brotliBytes: number;
  };
  readonly notices?: readonly TextureNotice[];
}

/**
 * Checks a stack without a server: opens every pack, builds the atlas in memory and reports
 * its revision, the packs' fingerprints and sizes, or what is wrong. Never writes anything.
 */
export async function validateTextureStack(
  source: TextureStackSource,
  options: Partial<SceneTextureOptions> = {},
): Promise<TextureStackReport> {
  const settings = {
    maxTileSize: options.maxTileSize ?? 32,
    budgetBytes: options.budgetBytes ?? 32 * 1024 * 1024,
  };
  try {
    const stack = await openResourcePackStack(source, options.limits);
    const packs = [];
    for (const pack of stack.packs) {
      packs.push({ ...pack.info, fingerprint: await packFingerprint(pack) });
    }
    const built = await buildTextureAtlas(stack, settings);
    const [gzipped, brotli] = await Promise.all([
      gzipAsync(built.bytes, { level: 9 }),
      brotliAsync(built.bytes, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
      }),
    ]);
    return {
      ok: true,
      errors: [],
      revision: built.fingerprint,
      stackFingerprint: stack.fingerprint,
      packs,
      atlas: {
        tileSize: built.atlas.tileSize,
        tiles: built.atlas.tiles.length,
        gpuBytes: built.gpuBytes,
        bytes: built.bytes.byteLength,
        gzipBytes: gzipped.byteLength,
        brotliBytes: brotli.byteLength,
      },
      notices: built.notices,
    };
  } catch (cause) {
    return { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] };
  }
}
