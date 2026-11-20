import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { openSceneWorld, type RegionRequest } from "@mapelix/scene-prototype";
import {
  DIMENSIONS,
  CAVE_LIMITS,
  sceneContext,
  type Dimension,
  type DimensionConfig,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_LIMITS,
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryRequest,
} from "@mapelix/scene-prototype/discoveries";

import { checkBounds, type BlockBounds } from "./bounds.js";
import { DiskCache, type DiskCacheStats } from "./disk-cache.js";
import {
  DiscoveryService,
  discoveryTiles,
  type DiscoveryServiceStats,
} from "./discovery-service.js";
import { parseExtent, scanWorldExtent, type WorldExtent } from "./extent.js";
import { DimensionPools } from "./pools.js";
import { Prewarmer, prewarmPlan, type PrewarmJob, type PrewarmProgress } from "./prewarm.js";
import {
  InvalidRegionError,
  RegionService,
  type LoadOptions,
  type RegionResult,
  type RegionServiceOptions,
  type RegionServiceStats,
} from "./region-service.js";
import { engineFingerprint, worldRevision } from "./revision.js";
import {
  failedReport,
  SceneTextures,
  type SceneAtlas,
  type TextureStackReport,
} from "./textures.js";
import type {
  PackLimits,
  ResourcePackInfo,
  TextureNotice,
  TextureStackSource,
} from "@mapelix/scene-prototype/textures";

export type { CacheStatus } from "./region-service.js";

export type SceneEvent = (event: string, detail: Record<string, unknown>) => void;

export interface SceneServerOptions {
  /** A Bedrock world folder (`db/`, and `level.dat` for the name and spawn); it is only read. */
  readonly worldDirectory: string;
  /** Region, cave and discovery caches, one folder per world revision. */
  readonly cacheDirectory: string;
  /** Builds that may run at once, across every dimension (default 1). */
  readonly workers?: number;
  /** Dimensions served (default all three). */
  readonly dimensions?: readonly Dimension[];
  /** A dimension's builders close after this many idle seconds; 0 keeps them (default 300). */
  readonly poolIdleSeconds?: number;
  /** Serve only this block rectangle in every dimension, instead of each one's stored area. */
  readonly bounds?: BlockBounds;
  /** Surface regions: memory, disk quota and distinct builds waiting (64, 1024, 32). */
  readonly memoryMiB?: number;
  readonly diskCacheMiB?: number;
  readonly maxPending?: number;
  /** Cave slices (16, 128, 8). */
  readonly caveMemoryMiB?: number;
  readonly caveDiskCacheMiB?: number;
  readonly caveMaxPending?: number;
  /** Discovery indexes (4, 64, 8). */
  readonly discoveryMemoryMiB?: number;
  readonly discoveryDiskCacheMiB?: number;
  readonly discoveryMaxPending?: number;
  /** Cache, pool and build events, for the host's log. */
  readonly onEvent?: SceneEvent;
  /**
   * Block textures from a stack of Bedrock resource packs, which the viewer may draw near the
   * camera. Without it nothing changes; a stack that cannot be read leaves the world untextured.
   */
  readonly textures?: SceneTextureOptions;
}

/**
 * Where the packs come from and what they may cost. `stack` is a read-only folder holding the
 * packs and `mapelix-stack.json` (see `docs/texture-stack.md`); `packs` lists folders, `.zip`
 * or `.mcpack` files, highest priority first.
 */
export type SceneTextureOptions = TextureStackSource & {
  /** Largest texture tile side, a power of two from 4 to 256 (default 32). */
  readonly maxTileSize?: number;
  /** GPU memory the atlas may take with its mipmaps (default 32). */
  readonly budgetMiB?: number;
  /** Bounds on reading the packs, per pack and for the stack. */
  readonly limits?: Partial<PackLimits>;
  /** Textured level 0 regions: memory, disk quota and distinct builds waiting (32, 512, 16). */
  readonly memoryMiB?: number;
  readonly diskCacheMiB?: number;
  readonly maxPending?: number;
};

/** A served region or discovery index and where it came from. */
export type LoadedRegion = RegionResult;

export interface WorldMetadata extends SceneContext {
  readonly dimension: Dimension;
  readonly ceilingY: number;
  readonly dimensions: readonly DimensionConfig[];
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  /** Changes with the world snapshot or the engine; clients add it to region URLs. */
  readonly revision: string;
  readonly caves: typeof CAVE_LIMITS;
  readonly snapshotRevision: string;
  readonly discoveries: typeof DISCOVERY_LIMITS;
  /** Present when a texture stack was given and its packs could be read. */
  readonly textures?: WorldTextures;
}

/**
 * Textures a client may draw: the atlas at `textures/<revision>/atlas.bin` and textured
 * regions with `textures=<revision>` in their query string.
 */
export interface WorldTextures {
  /** Changes with any pack, the pack order or the atlas options, apart from the world revision. */
  readonly revision: string;
  /** The packs in use, highest priority first, as their manifests describe them. */
  readonly packs: readonly ResourcePackInfo[];
}

/** The texture stack in use, for a health page. */
export type TextureStats =
  | (WorldTextures & {
      /** `stored` once the atlas is built or read, `failed` when its build failed. */
      readonly state: "stored" | "not-built" | "failed";
      readonly error?: string;
      readonly atlas?: {
        readonly tileSize: number;
        readonly tiles: number;
        readonly gpuBytes: number;
        readonly bytes: number;
        readonly gzipBytes: number;
        readonly brotliBytes: number;
      };
    })
  | { readonly error: string };

export interface PrewarmOptions {
  /** Near-region variants to prepare (default [true]); use [true, false] for both modes. */
  readonly blockLightModes?: readonly boolean[];
  /** At most this many Surface regions, coarse levels and the middle of the world first. */
  readonly maxRegions?: number;
  /** Then every discovery index of the stored area (default true). */
  readonly discoveries?: boolean;
  readonly signal?: AbortSignal;
}

export interface PrewarmResult {
  readonly regions: PrewarmProgress;
  readonly discoveries: PrewarmProgress;
  /** The atlas, then textured level 0 Surface regions; idle without textures. */
  readonly textures: PrewarmProgress;
}

export interface SceneServerStats {
  readonly revision: string;
  readonly workers: number;
  readonly dimensions: readonly Dimension[];
  readonly openDimensions: readonly Dimension[];
  readonly surface: { readonly builds: RegionServiceStats; readonly cache: DiskCacheStats };
  readonly caves: { readonly builds: RegionServiceStats; readonly cache: DiskCacheStats };
  /** Textured level 0 regions, with a texture stack only. */
  readonly textured?: { readonly builds: RegionServiceStats; readonly cache: DiskCacheStats };
  /** Textured level 0 cave slices, with a texture stack only. */
  readonly texturedCaves?: {
    readonly builds: RegionServiceStats;
    readonly cache: DiskCacheStats;
  };
  readonly discoveries: {
    readonly builds: DiscoveryServiceStats;
    readonly cache: DiskCacheStats;
  };
  readonly prewarm: PrewarmResult;
  /** The textures in use, the reason they are not, or nothing without a stack. */
  readonly textures?: TextureStats;
}

/** The world folder holds no Bedrock world: a configuration error that a retry cannot fix. */
export class MissingWorldError extends Error {
  override readonly name = "MissingWorldError";
}

export type SceneServer = ReturnType<typeof createSceneServer>;

const MIB = 1024 * 1024;
const IDLE: PrewarmProgress = { state: "idle", done: 0, total: 0, built: 0, failed: 0 };

interface Opened {
  readonly revision: string;
  readonly info: {
    readonly name: string;
    readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  };
  readonly bounds: ReadonlyMap<Dimension, BlockBounds | undefined>;
  readonly pools: DimensionPools;
  readonly disks: {
    readonly surface: DiskCache;
    readonly caves: DiskCache;
    readonly discoveries: DiskCache;
  };
  readonly surface: RegionService;
  readonly caves: RegionService;
  readonly discoveries: DiscoveryService;
  readonly build: RegionServiceOptions["build"];
}

/** A texture stack and the services of its textured regions, replaced as a whole. */
interface TextureSet {
  readonly stack: SceneTextures;
  /** Textured level 0 Surface regions. */
  readonly surface: { readonly service: RegionService; readonly disk: DiskCache };
  /** Textured level 0 cave slices, built on demand like plain ones. */
  readonly caves: { readonly service: RegionService; readonly disk: DiskCache };
}

/**
 * Builds and caches 3D scene regions and discovery indexes of one Bedrock world. Builds are
 * shared between callers and bounded (`OverloadedError` past `maxPending`), every cache has a
 * byte budget, older world revisions leave the disk when the server opens, and anything outside
 * the stored area is answered with an empty payload without a build. A dimension's builder
 * threads close when it stays idle. Nothing here listens on a port: the host routes requests,
 * for instance through `createSceneHandler`.
 */
export function createSceneServer(options: SceneServerOptions) {
  const worldDirectory = resolve(options.worldDirectory);
  const cacheDirectory = resolve(options.cacheDirectory);
  const workers = positiveInteger(options.workers ?? 1, "workers");
  const served = [...new Set(options.dimensions ?? (Object.keys(DIMENSIONS) as Dimension[]))];
  if (served.length === 0) throw new RangeError("dimensions must name at least one dimension");
  for (const dimension of served)
    if (!Object.hasOwn(DIMENSIONS, dimension))
      throw new RangeError(`Unknown dimension ${dimension}`);
  const idleSeconds = wholeNumber(options.poolIdleSeconds ?? 300, "poolIdleSeconds");
  const bounds = options.bounds === undefined ? undefined : checkBounds(options.bounds);
  const sizes = {
    memory: wholeNumber(options.memoryMiB ?? 64, "memoryMiB") * MIB,
    disk: positiveInteger(options.diskCacheMiB ?? 1024, "diskCacheMiB") * MIB,
    pending: positiveInteger(options.maxPending ?? 32, "maxPending"),
    caveMemory: wholeNumber(options.caveMemoryMiB ?? 16, "caveMemoryMiB") * MIB,
    caveDisk: positiveInteger(options.caveDiskCacheMiB ?? 128, "caveDiskCacheMiB") * MIB,
    cavePending: positiveInteger(options.caveMaxPending ?? 8, "caveMaxPending"),
    discoveryMemory: wholeNumber(options.discoveryMemoryMiB ?? 4, "discoveryMemoryMiB") * MIB,
    discoveryDisk:
      positiveInteger(options.discoveryDiskCacheMiB ?? 64, "discoveryDiskCacheMiB") * MIB,
    discoveryPending: positiveInteger(options.discoveryMaxPending ?? 8, "discoveryMaxPending"),
  };
  const textureOptions = options.textures;
  const textureSource =
    textureOptions === undefined ? undefined : resolveTextureSource(textureOptions);
  const textureMaxTileSize = textureOptions?.maxTileSize ?? 32;
  if (
    !Number.isInteger(Math.log2(textureMaxTileSize)) ||
    textureMaxTileSize < 4 ||
    textureMaxTileSize > 256
  )
    throw new RangeError("textures.maxTileSize must be a power of two from 4 to 256");
  const textureSettings = {
    maxTileSize: textureMaxTileSize,
    budgetBytes: positiveInteger(textureOptions?.budgetMiB ?? 32, "textures.budgetMiB") * MIB,
    ...(textureOptions?.limits === undefined ? {} : { limits: textureOptions.limits }),
  };
  const texturedSizes = {
    memory: wholeNumber(textureOptions?.memoryMiB ?? 32, "textures.memoryMiB") * MIB,
    disk: positiveInteger(textureOptions?.diskCacheMiB ?? 512, "textures.diskCacheMiB") * MIB,
    pending: positiveInteger(textureOptions?.maxPending ?? 16, "textures.maxPending"),
  };
  const onEvent = options.onEvent;
  const event = (name: string, detail: Record<string, unknown>) => onEvent?.(name, detail);
  let opening: Promise<Opened> | undefined;
  let closed = false;
  let regionPrewarm: Prewarmer | undefined;
  let discoveryPrewarm: Prewarmer | undefined;
  let texturePrewarm: Prewarmer | undefined;
  let stopTexturePrewarm: AbortController | undefined;
  let prewarming: Promise<PrewarmResult> | undefined;
  /** The running prewarm's size and signal, once it reaches the textured regions. */
  let texturePrewarmRun:
    | {
        readonly maxRegions: number;
        readonly signal: AbortSignal;
        readonly blockLightModes: readonly boolean[];
      }
    | undefined;
  const stopPrewarm = new AbortController();
  // The texture stack may change while the server runs (`setTextures`); changes run in turn.
  let textureSet: TextureSet | undefined;
  let textureError: string | undefined;
  let textureChange: Promise<unknown> = Promise.resolve();

  /** Checks the world, opens the caches and reads the stored area, once. */
  function ready(): Promise<Opened> {
    if (closed) return Promise.reject(new Error("The scene server is closed"));
    if (opening === undefined) {
      const started = open();
      opening = started;
      // A failed start may be retried, such as once the world folder is in place.
      started.catch(() => {
        if (opening === started) opening = undefined;
      });
    }
    return opening;
  }

  async function open(): Promise<Opened> {
    await requireWorld(worldDirectory);
    const revision = await worldRevision(worldDirectory, await engineFingerprint());
    const events = { onEvent: event };
    const surfaceDisk = await DiskCache.open(cacheDirectory, revision, sizes.disk, events);
    const caveDisk = await DiskCache.open(
      join(cacheDirectory, "caves"),
      revision,
      sizes.caveDisk,
      events,
    );
    const discoveryFolder = `discoveries-v${DISCOVERY_SCHEMA_VERSION}`;
    await removeOldDiscoveryFolders(cacheDirectory, discoveryFolder, event);
    const discoveryDisk = await DiskCache.open(
      join(cacheDirectory, discoveryFolder),
      revision,
      sizes.discoveryDisk,
      events,
    );
    // Packs are optional: one that cannot be read leaves the world untextured, not unavailable.
    let textures: SceneTextures | undefined;
    let error: string | undefined;
    if (textureSource !== undefined) {
      try {
        textures = await SceneTextures.open(textureSource, cacheDirectory, textureSettings, event);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        event("textures.failed", { message: error });
      }
    }
    // Atlases of other stacks, such as one set while the server last ran, leave the disk.
    if (error === undefined) {
      await SceneTextures.removeOtherRevisions(cacheDirectory, textures?.revision, event);
      if (textures === undefined) {
        for (const folder of ["regions", "caves"])
          await rm(join(cacheDirectory, "textures", folder), { recursive: true, force: true });
      }
    }
    const extent = bounds === undefined ? await loadExtent(revision) : undefined;
    const servedBounds = new Map<Dimension, BlockBounds | undefined>(
      served.map((dimension) => [dimension, bounds ?? extent?.[dimension]]),
    );
    const pools = new DimensionPools({
      open: (dimension) => openSceneWorld({ directory: worldDirectory, dimension, workers }),
      permits: workers,
      idleMilliseconds: idleSeconds * 1000,
      onEvent: event,
    });
    // Opening one dimension proves the snapshot reads; its name and spawn serve every dimension.
    const first = await pools.world(served.includes("overworld") ? "overworld" : served[0]!);
    const build = (
      dimension: Dimension,
      request: RegionRequest,
      signal: AbortSignal,
      background?: boolean,
    ) => pools.build(dimension, request, signal, background);
    const opened = { revision, bounds: servedBounds, build };
    textureSet = textures === undefined ? undefined : await openTextureSet(opened, textures, true);
    textureError = error;
    return {
      ...opened,
      info: { name: first.info.name, spawn: first.info.spawn },
      pools,
      disks: { surface: surfaceDisk, caves: caveDisk, discoveries: discoveryDisk },
      surface: new RegionService({
        mode: "surface",
        dimensions: servedBounds,
        build,
        store: surfaceDisk,
        memoryBytes: sizes.memory,
        maxPending: sizes.pending,
        onEvent: event,
      }),
      caves: new RegionService({
        mode: "caves",
        dimensions: servedBounds,
        build,
        store: caveDisk,
        memoryBytes: sizes.caveMemory,
        maxPending: sizes.cavePending,
        onEvent: event,
      }),
      discoveries: new DiscoveryService({
        dimensions: servedBounds,
        build: (dimension, tile, signal, background) =>
          pools.discoveries(dimension, tile, signal, background),
        store: discoveryDisk,
        memoryBytes: sizes.discoveryMemory,
        memoryEntries: 256,
        maxPending: sizes.discoveryPending,
        onEvent: event,
      }),
    };
  }

  /**
   * The services of a stack's textured regions and cave slices. Their caches depend on the
   * world and the stack; at start other pairs leave the disk, and while running the set it
   * replaces is retired. Textured cave slices take the cave cache sizes.
   */
  async function openTextureSet(
    world: Pick<Opened, "revision" | "bounds" | "build">,
    stack: SceneTextures,
    removeOthers: boolean,
  ): Promise<TextureSet> {
    const pair = createHash("sha256")
      .update(`${world.revision}\0${stack.revision}`)
      .digest("hex")
      .slice(0, 20);
    const textures = async () => (await stack.load())!.index;
    const open = async (
      mode: "surface" | "caves",
      folder: string,
      limits: { readonly memory: number; readonly disk: number; readonly pending: number },
    ) => {
      const disk = await DiskCache.open(
        join(cacheDirectory, "textures", folder),
        pair,
        limits.disk,
        { onEvent: event },
        { removeOthers },
      );
      const service = new RegionService({
        mode,
        dimensions: world.bounds,
        build: world.build,
        store: disk,
        memoryBytes: limits.memory,
        maxPending: limits.pending,
        onEvent: event,
        textures,
      });
      return { service, disk };
    };
    return {
      stack,
      surface: await open("surface", "regions", texturedSizes),
      caves: await open("caves", "caves", {
        memory: sizes.caveMemory,
        disk: sizes.caveDisk,
        pending: sizes.cavePending,
      }),
    };
  }

  /** Removes a replaced stack's atlas and textured regions from the disk. */
  async function retireTextureSet(set: TextureSet): Promise<void> {
    await Promise.all([set.stack.retire(), set.surface.disk.retire(), set.caves.disk.retire()]);
  }

  /**
   * Replaces the texture stack without a restart, or removes it with `null`. The packs are read
   * and the atlas is built before anything changes: a stack that cannot be read or built leaves
   * the current one in place and comes back as a failed report, as `validateTextureStack` would
   * give it. Then the world metadata names the new revision, requests for the previous one answer
   * 409 like a changed world, and its atlas and textured regions leave the disk. Calls run one
   * after another; the stack uses the atlas options and limits the server was created with.
   */
  function setTextures(source: TextureStackSource | null): Promise<TextureStackReport> {
    const change = textureChange.then(() => replaceTextures(source));
    textureChange = change.catch(() => undefined);
    return change;
  }

  async function replaceTextures(source: TextureStackSource | null): Promise<TextureStackReport> {
    if (closed) throw new Error("The scene server is closed");
    const world = await ready();
    const previous = textureSet;
    if (source === null) {
      textureSet = undefined;
      textureError = undefined;
      if (previous !== undefined) {
        stopTexturePrewarm?.abort();
        await retireTextureSet(previous);
        event("textures.changed", { previous: previous.stack.revision });
      }
      return { ok: true, errors: [] };
    }
    let next: SceneTextures;
    try {
      next = await SceneTextures.open(
        resolveTextureSource(source),
        cacheDirectory,
        textureSettings,
        event,
      );
    } catch (cause) {
      event("textures.rejected", { message: String(cause) });
      return failedReport(cause);
    }
    if (previous?.stack.revision === next.revision) {
      return previous.stack.report().catch(failedReport);
    }
    let report: TextureStackReport;
    try {
      report = await next.report();
    } catch (cause) {
      await next.retire();
      event("textures.rejected", { message: String(cause) });
      return failedReport(cause);
    }
    const set = await openTextureSet(world, next, false);
    if (closed) {
      await retireTextureSet(set);
      throw new Error("The scene server is closed");
    }
    textureSet = set;
    textureError = undefined;
    stopTexturePrewarm?.abort();
    if (previous !== undefined) await retireTextureSet(previous);
    event("textures.changed", {
      revision: next.revision,
      ...(previous === undefined ? {} : { previous: previous.stack.revision }),
    });
    // A prewarm that already reached the textured regions starts them again for the new stack.
    if (texturePrewarmRun !== undefined && !texturePrewarmRun.signal.aborted) {
      void prewarmTextures(
        world,
        set,
        texturePrewarmRun.maxRegions,
        texturePrewarmRun.signal,
        texturePrewarmRun.blockLightModes,
      );
    }
    return report;
  }

  /** Builds the textured level 0 Surface regions of a stack, behind every visitor. */
  async function prewarmTextures(
    world: Opened,
    set: TextureSet,
    maxRegions: number,
    signal: AbortSignal,
    blockLightModes: readonly boolean[],
  ): Promise<PrewarmProgress> {
    stopTexturePrewarm?.abort();
    const stop = new AbortController();
    stopTexturePrewarm = stop;
    texturePrewarmRun = { maxRegions, signal, blockLightModes };
    const jobs = prewarmPlan(world.bounds, maxRegions, blockLightModes).filter(
      (job) => job.level === 0,
    );
    const prewarmer = new Prewarmer(
      {
        load: async (dimension, request, jobSignal, load) => {
          // The atlas comes first; a failed atlas stops the run on its first job.
          await set.stack.load();
          return set.surface.service.load(dimension, request, jobSignal, load);
        },
      },
      jobs,
      nearlyFull(set.surface.disk),
      (name, detail) => event(`textures.${name}`, detail),
    );
    texturePrewarm = prewarmer;
    return prewarmer.run(AbortSignal.any([signal, stop.signal]));
  }

  /** The stored area saved for this revision, or one scan of the database keys. */
  async function loadExtent(revision: string): Promise<WorldExtent> {
    const saved = join(cacheDirectory, revision, "extent.json");
    const cached = await readFile(saved, "utf8")
      .then(parseExtent)
      .catch(() => undefined);
    if (cached !== undefined) return cached;
    const startedAt = performance.now();
    const extent = await scanWorldExtent(worldDirectory);
    event("world.extent-scanned", {
      milliseconds: Math.round(performance.now() - startedAt),
      extent,
    });
    await writeFile(saved, JSON.stringify(extent)).catch((cause: unknown) =>
      event("world.extent-not-saved", { message: String(cause) }),
    );
    return extent;
  }

  async function getWorldMetadata(
    input: SceneContextInput = sceneContext(),
  ): Promise<WorldMetadata> {
    const context = sceneContext(input.dimension, input);
    const world = await ready();
    const spawn =
      context.dimension === "overworld"
        ? world.info.spawn
        : context.dimension === "nether"
          ? {
              x: Math.floor(world.info.spawn.x / 8),
              y: 64,
              z: Math.floor(world.info.spawn.z / 8),
            }
          : { x: 100, y: 64, z: 0 };
    return {
      name: world.info.name,
      spawn: context.mode === "caves" ? { ...spawn, y: (context.minY + context.maxY) / 2 } : spawn,
      revision: world.revision,
      ...context,
      dimensions: served.map((dimension) => DIMENSIONS[dimension]),
      caves: CAVE_LIMITS,
      snapshotRevision: world.revision,
      discoveries: DISCOVERY_LIMITS,
      ...(textureSet === undefined
        ? {}
        : { textures: { revision: textureSet.stack.revision, packs: textureSet.stack.packs } }),
    };
  }

  /**
   * The atlas of texture `revision`, built on first use and stored; undefined for another
   * revision, without textures, or with `cacheOnly` when it is not stored yet. A failed build
   * rejects.
   */
  async function loadTextureAtlas(
    revision: string,
    load: Pick<LoadOptions, "cacheOnly"> = {},
  ): Promise<SceneAtlas | undefined> {
    await ready();
    const stack = textureSet?.stack;
    if (stack?.revision !== revision) return undefined;
    return stack.load(load.cacheOnly === true);
  }

  /** The packs and files the atlas of `revision` was made of, for attribution. */
  async function loadTextureNotices(
    revision: string,
    load: Pick<LoadOptions, "cacheOnly"> = {},
  ): Promise<readonly TextureNotice[] | undefined> {
    return (await loadTextureAtlas(revision, load))?.notices;
  }

  /** The texture revision served, or undefined without textures. */
  async function getTextureRevision(): Promise<string | undefined> {
    await ready();
    return textureSet?.stack.revision;
  }

  /**
   * A serialized region from memory, the disk cache, a shared build, or an empty one outside
   * the stored area. A build every caller abandoned stops before it starts. Rejects with
   * `InvalidRegionError`, `OverloadedError` or, with `cacheOnly`, `NotCachedError`. With
   * `textures`, the texture revision served, it is the textured level 0 Surface region or cave
   * slice, and with `cutout` too, its variant that draws the faces between leaves and other
   * cut-out blocks.
   */
  async function loadRegion(
    request: RegionRequest,
    signal: AbortSignal,
    input: SceneContextInput = sceneContext("overworld", request),
    load: Pick<LoadOptions, "cacheOnly"> & {
      readonly textures?: string;
      readonly cutout?: boolean;
    } = {},
  ): Promise<LoadedRegion> {
    const context = sceneContext(input.dimension, input);
    const world = await ready();
    const position = {
      level: request.level,
      x: request.x,
      z: request.z,
      ...(request.blockLight === undefined ? {} : { blockLight: request.blockLight }),
    };
    if (load.textures !== undefined) {
      const set = textureSet;
      if (set === undefined || load.textures !== set.stack.revision) {
        throw new InvalidRegionError(`No texture revision ${load.textures} is served`);
      }
      if (context.mode === "caves") {
        return set.caves.service.load(
          context.dimension,
          {
            ...position,
            mode: "caves",
            minY: context.minY,
            maxY: context.maxY,
            ceilingY: context.ceilingY,
            ...(load.cutout === true ? { cutout: true } : {}),
          },
          signal,
          load.cacheOnly === true ? { cacheOnly: true } : {},
        );
      }
      return set.surface.service.load(
        context.dimension,
        {
          ...position,
          ceilingY: context.ceilingY,
          ...(load.cutout === true ? { cutout: true } : {}),
        },
        signal,
        load.cacheOnly === true ? { cacheOnly: true } : {},
      );
    }
    const resolved: RegionRequest =
      context.mode === "caves"
        ? {
            ...position,
            mode: "caves",
            minY: context.minY,
            maxY: context.maxY,
            ceilingY: context.ceilingY,
          }
        : { ...position, ceilingY: context.ceilingY };
    return (context.mode === "caves" ? world.caves : world.surface).load(
      context.dimension,
      resolved,
      signal,
      load.cacheOnly === true ? { cacheOnly: true } : {},
    );
  }

  /** The all-height discovery index of one 32-block tile; it depends on the snapshot only. */
  async function loadDiscoveries(
    dimension: Dimension,
    tile: DiscoveryRequest,
    signal: AbortSignal,
    load: Pick<LoadOptions, "cacheOnly"> = {},
  ): Promise<LoadedRegion> {
    const world = await ready();
    return world.discoveries.load(
      dimension,
      tile,
      signal,
      load.cacheOnly === true ? { cacheOnly: true } : {},
    );
  }

  /** The name and states of the block at one position, read from the world as it is served. */
  async function readBlock(
    dimension: Dimension,
    position: { readonly x: number; readonly y: number; readonly z: number },
    signal: AbortSignal,
  ): Promise<{ readonly name: string | null; readonly states?: Record<string, unknown> }> {
    const world = await ready();
    const built = await world.pools.block(dimension, position, signal);
    return JSON.parse(new TextDecoder().decode(built.bytes)) as {
      name: string | null;
      states?: Record<string, unknown>;
    };
  }

  async function getRevision(): Promise<string> {
    return (await ready()).revision;
  }

  /**
   * Builds the Surface regions of the stored area, coarse levels and the middle first, then
   * every discovery index, one at a time behind every visitor; regions already on disk are only
   * read. It stops when a disk cache is nearly full. A second call returns the first run.
   */
  function prewarm(prewarmOptions: PrewarmOptions = {}): Promise<PrewarmResult> {
    prewarming ??= (async () => {
      const world = await ready();
      const signal =
        prewarmOptions.signal === undefined
          ? stopPrewarm.signal
          : AbortSignal.any([stopPrewarm.signal, prewarmOptions.signal]);
      const maxRegions = positiveInteger(prewarmOptions.maxRegions ?? 100_000, "maxRegions");
      const blockLightModes = [...(prewarmOptions.blockLightModes ?? [true])];
      regionPrewarm = new Prewarmer(
        world.surface,
        prewarmPlan(world.bounds, maxRegions, blockLightModes),
        nearlyFull(world.disks.surface),
        event,
      );
      const discoveryJobs: PrewarmJob[] =
        prewarmOptions.discoveries === false
          ? []
          : [...world.bounds].flatMap(([dimension, stored]) =>
              stored === undefined
                ? []
                : discoveryTiles(stored).map((tile) => ({ dimension, level: 0, ...tile })),
            );
      discoveryPrewarm = new Prewarmer(
        {
          load: (dimension, request, jobSignal, load) =>
            world.discoveries.load(dimension, { x: request.x, z: request.z }, jobSignal, load),
        },
        discoveryJobs,
        nearlyFull(world.disks.discoveries),
        (name, detail) => event(`discoveries.${name}`, detail),
      );
      const regions = await regionPrewarm.run(signal);
      const discoveries = signal.aborted
        ? discoveryPrewarm.progress
        : await discoveryPrewarm.run(signal);
      let textures = IDLE;
      if (!signal.aborted) {
        // Later stacks set with `setTextures` are prewarmed in turn.
        texturePrewarmRun = { maxRegions, signal, blockLightModes };
        if (textureSet !== undefined) {
          textures = await prewarmTextures(world, textureSet, maxRegions, signal, blockLightModes);
        }
      }
      return { regions, discoveries, textures };
    })();
    return prewarming;
  }

  /** Builds, caches, open dimensions and prewarm progress, for a health page. */
  async function stats(): Promise<SceneServerStats> {
    const world = await ready();
    return {
      revision: world.revision,
      workers,
      dimensions: served,
      openDimensions: world.pools.openDimensions,
      surface: { builds: world.surface.stats, cache: world.disks.surface.stats },
      caves: { builds: world.caves.stats, cache: world.disks.caves.stats },
      ...(textureSet === undefined
        ? {}
        : {
            textured: {
              builds: textureSet.surface.service.stats,
              cache: textureSet.surface.disk.stats,
            },
            texturedCaves: {
              builds: textureSet.caves.service.stats,
              cache: textureSet.caves.disk.stats,
            },
          }),
      discoveries: { builds: world.discoveries.stats, cache: world.disks.discoveries.stats },
      prewarm: {
        regions: regionPrewarm?.progress ?? IDLE,
        discoveries: discoveryPrewarm?.progress ?? IDLE,
        textures: texturePrewarm?.progress ?? IDLE,
      },
      ...(textureSet !== undefined
        ? { textures: textureStats(textureSet.stack) }
        : textureError !== undefined
          ? { textures: { error: textureError } }
          : {}),
    };
  }

  /** Stops the prewarm and closes the world databases and worker threads. */
  async function close(): Promise<void> {
    stopPrewarm.abort();
    const pending = opening;
    closed = true;
    await textureChange;
    const world = await pending?.catch(() => undefined);
    await world?.pools.close();
  }

  return {
    /** Resolves once the world is checked and the caches are open; rejects on a missing world. */
    ready: async (): Promise<void> => void (await ready()),
    getWorldMetadata,
    loadRegion,
    loadDiscoveries,
    readBlock,
    loadTextureAtlas,
    loadTextureNotices,
    getTextureRevision,
    setTextures,
    getRevision,
    getSnapshotRevision: getRevision,
    prewarm,
    stats,
    close,
  };
}

/** Packs and stack folders as absolute paths, so a later change of directory changes nothing. */
function resolveTextureSource(source: TextureStackSource): TextureStackSource {
  return "stack" in source
    ? { stack: resolve(source.stack) }
    : { packs: source.packs.map((pack) => resolve(pack)) };
}

function nearlyFull(disk: DiskCache): () => boolean {
  return () => disk.stats.bytes > disk.stats.maxBytes * 0.85;
}

function textureStats(textures: SceneTextures): TextureStats {
  const atlas = textures.ready;
  const base = { revision: textures.revision, packs: textures.packs };
  if (atlas === undefined) {
    return textures.error === undefined
      ? { ...base, state: "not-built" }
      : { ...base, state: "failed", error: textures.error };
  }
  return {
    ...base,
    state: "stored",
    atlas: {
      tileSize: atlas.tileSize,
      tiles: atlas.tiles,
      gpuBytes: atlas.gpuBytes,
      bytes: atlas.bytes.byteLength,
      gzipBytes: atlas.gzip.byteLength,
      brotliBytes: atlas.brotli.byteLength,
    },
  };
}

/** A missing or partial snapshot is a configuration error: retrying cannot fix it. */
async function requireWorld(directory: string): Promise<void> {
  // The name and spawn in `level.dat` are optional; the database is not.
  const database = await stat(join(directory, "db")).catch(() => undefined);
  if (database?.isDirectory() !== true)
    throw new MissingWorldError("The world folder holds no Bedrock world database (db/)");
}

/** Discovery folders of an older index schema can never be read again. */
async function removeOldDiscoveryFolders(
  root: string,
  current: string,
  event: SceneEvent,
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      /^discoveries-v\d{1,4}$/.test(entry.name) &&
      entry.name !== current
    ) {
      await rm(join(root, entry.name), { recursive: true, force: true });
      event("cache.schema-removed", { folder: entry.name });
    }
  }
}

export function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${value}`);
  }
  return value;
}

function wholeNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a whole number, received ${value}`);
  }
  return value;
}
