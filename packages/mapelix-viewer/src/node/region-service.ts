import type { Dimension, PaletteTextures, RegionRequest } from "@mapelix/scene-prototype";

import {
  CAVE_LIMITS,
  regionCacheKey,
  sceneContext,
  type SceneContext,
  type ViewMode,
} from "@mapelix/scene-prototype/dimensions";
import {
  EMPTY_HEIGHT,
  MAX_REGION_LEVEL,
  decodeSceneRegion,
  encodeSceneRegion,
  regionGridSize,
  regionSpan,
} from "@mapelix/scene-prototype/format";

import { ByteLru, Flights, isAbort } from "./build-cache.js";
import { WORLD_LIMIT, type BlockBounds } from "./bounds.js";
import { regionTouches } from "./extent.js";

export { OverloadedError, isAbort } from "./build-cache.js";

export type CacheStatus = "memory" | "disk" | "build" | "empty";

export interface RegionResult {
  readonly bytes: Uint8Array;
  readonly cacheStatus: CacheStatus;
  readonly milliseconds: number;
}

export interface BuiltBytes {
  readonly bytes: Uint8Array;
  readonly milliseconds: number;
}

/**
 * The request handed to a build always carries its resolved ceiling; a cave request
 * also carries its mode and floor. Background builds wait behind every visitor.
 */
export type BuildRegion = (
  dimension: Dimension,
  request: RegionRequest & { readonly ceilingY: number },
  signal: AbortSignal,
  background?: boolean,
) => Promise<BuiltBytes>;

export interface RegionStore {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, bytes: Uint8Array): Promise<void>;
  discard(key: string): Promise<void>;
}

export interface RegionServiceOptions {
  /** The geometry this service builds and caches: surface views or cave slices. */
  readonly mode?: ViewMode;
  /** Served dimensions and their stored area; undefined means the dimension stores nothing. */
  readonly dimensions: ReadonlyMap<Dimension, BlockBounds | undefined>;
  readonly build: BuildRegion;
  readonly store: RegionStore | undefined;
  readonly memoryBytes: number;
  readonly maxPending: number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /**
   * Builds textured level 0 regions with the texture index this returns, which may build the
   * atlas first. Such a service serves level 0 only.
   */
  readonly textures?: () => Promise<PaletteTextures>;
}

export interface RegionServiceStats {
  readonly inFlight: number;
  readonly maxPending: number;
  readonly memoryEntries: number;
  readonly memoryBytes: number;
  readonly built: number;
  readonly rejected: number;
  readonly failed: number;
}

/** A cache-only request asked for a region that has not been built yet. */
export class NotCachedError extends Error {
  override readonly name = "NotCachedError";
}

export interface LoadOptions {
  /** Answer only from memory or disk; never start or join a build. */
  readonly cacheOnly?: boolean;
  /** A prewarm build: it waits for a free builder behind every visitor. */
  readonly background?: boolean;
}

/** The request names a dimension, level, or position this server never serves. */
export class InvalidRegionError extends Error {
  override readonly name = "InvalidRegionError";
}

/**
 * Serves scene regions from memory, the disk cache, or a bounded set of builds.
 * Regions outside the stored area are answered with an empty region without any
 * build or disk write, so a camera looking at the horizon costs nothing, and a
 * client cannot fill the cache with regions far from the world.
 */
export class RegionService {
  private readonly options: RegionServiceOptions;
  private readonly mode: ViewMode;
  private readonly memory: ByteLru;
  private readonly flights: Flights<RegionResult>;
  private built = 0;
  private failed = 0;

  constructor(options: RegionServiceOptions) {
    this.options = options;
    this.mode = options.mode ?? "surface";
    this.memory = new ByteLru(options.memoryBytes);
    this.flights = new Flights(options.maxPending);
  }

  get stats(): RegionServiceStats {
    return {
      inFlight: this.flights.size,
      maxPending: this.options.maxPending,
      memoryEntries: this.memory.size,
      memoryBytes: this.memory.bytes,
      built: this.built,
      rejected: this.flights.rejected,
      failed: this.failed,
    };
  }

  async load(
    dimension: Dimension,
    request: RegionRequest,
    signal: AbortSignal,
    options: LoadOptions = {},
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    const { level, x, z } = request;
    if (!this.options.dimensions.has(dimension)) {
      throw new InvalidRegionError(`Dimension ${dimension} is not served`);
    }
    validateRegion(level, x, z);
    const textured = this.options.textures !== undefined;
    if (textured && level !== 0) {
      throw new InvalidRegionError("Textured regions are level 0 only");
    }
    const context = resolveContext(dimension, request);
    if (context.mode !== this.mode) {
      throw new InvalidRegionError(`This service builds ${this.mode} regions only`);
    }
    if (context.mode === "caves" && level > CAVE_LIMITS.maxLevel) {
      throw new InvalidRegionError(`Caves use region levels 0 through ${CAVE_LIMITS.maxLevel}`);
    }
    const bounds = this.options.dimensions.get(dimension);
    if (bounds === undefined || !regionTouches(bounds, regionSpan(level), x, z)) {
      return {
        bytes: emptyRegionBytes(level, x, z, textured),
        cacheStatus: "empty",
        milliseconds: performance.now() - startedAt,
      };
    }

    // Each vertical window cuts the geometry differently, so it is part of every key.
    const key = regionCacheKey(context, { level, x, z });
    const remembered = this.memory.get(key);
    if (remembered !== undefined) {
      return {
        bytes: remembered,
        cacheStatus: "memory",
        milliseconds: performance.now() - startedAt,
      };
    }

    if (options.cacheOnly === true) {
      const stored = await this.readStored(key, request);
      if (stored === undefined) throw new NotCachedError(`Region ${key} is not built yet`);
      return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
    }

    // Surface builds keep their historical request shape; caves name the whole window.
    const build =
      context.mode === "surface"
        ? { level, x, z, ceilingY: context.ceilingY }
        : {
            level,
            x,
            z,
            mode: context.mode,
            minY: context.minY,
            maxY: context.maxY,
            ceilingY: context.ceilingY,
          };
    return this.flights.join(
      key,
      (flightSignal) =>
        this.readOrBuild(key, dimension, build, flightSignal, options.background === true),
      signal,
    );
  }

  private async readOrBuild(
    key: string,
    dimension: Dimension,
    request: RegionRequest & { readonly ceilingY: number },
    signal: AbortSignal,
    background: boolean,
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    const store = this.options.store;
    const stored = await this.readStored(key, request);
    if (stored !== undefined) {
      return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
    }

    let built: BuiltBytes;
    try {
      const textures = await this.options.textures?.();
      built = await this.options.build(
        dimension,
        textures === undefined ? request : { ...request, textures },
        signal,
        background,
      );
    } catch (cause) {
      if (!isAbort(cause)) {
        this.failed += 1;
        this.options.onEvent?.("region.build-failed", { key, message: String(cause) });
      }
      throw cause;
    }
    this.built += 1;
    const bytes = aligned(built.bytes);
    await store?.write(key, bytes);
    this.memory.set(key, bytes);
    return { bytes, cacheStatus: "build", milliseconds: built.milliseconds };
  }

  /** A valid region from the disk cache, kept in memory too; corrupt files are dropped. */
  private async readStored(key: string, request: RegionRequest): Promise<Uint8Array | undefined> {
    const store = this.options.store;
    const stored = await store?.read(key);
    if (stored === undefined) return undefined;
    const bytes = aligned(stored);
    if (isValidRegion(bytes, request, this.options.textures !== undefined)) {
      this.memory.set(key, bytes);
      return bytes;
    }
    this.options.onEvent?.("cache.discarded", { key });
    await store?.discard(key);
    return undefined;
  }
}

/** The dimension's default view, or the requested window the engine accepts. */
export function resolveContext(
  dimension: Dimension,
  request: Pick<RegionRequest, "mode" | "minY" | "maxY" | "ceilingY"> = {},
): SceneContext {
  try {
    return sceneContext(dimension, {
      ...(request.mode === undefined ? {} : { mode: request.mode }),
      ...(request.minY === undefined ? {} : { minY: request.minY }),
      ...(request.maxY === undefined ? {} : { maxY: request.maxY }),
      ...(request.ceilingY === undefined ? {} : { ceilingY: request.ceilingY }),
    });
  } catch (cause) {
    throw new InvalidRegionError(cause instanceof Error ? cause.message : String(cause));
  }
}

/** Rejects levels and positions the viewer never asks for, before any work. */
export function validateRegion(level: number, x: number, z: number): void {
  if (!Number.isSafeInteger(level) || level < 0 || level > MAX_REGION_LEVEL) {
    throw new InvalidRegionError(`Region level must be 0 through ${MAX_REGION_LEVEL}`);
  }
  const limit = Math.ceil(WORLD_LIMIT / regionSpan(level));
  if (
    !Number.isSafeInteger(x) ||
    !Number.isSafeInteger(z) ||
    Math.abs(x) > limit ||
    Math.abs(z) > limit
  ) {
    throw new InvalidRegionError("Region coordinates lie beyond the world border");
  }
}

/** A region with no blocks, which the viewer treats as already loaded and empty. */
export function emptyRegionBytes(
  level: number,
  x: number,
  z: number,
  textured = false,
): Uint8Array {
  const empty = new Uint32Array(0);
  return encodeSceneRegion({
    level,
    x,
    z,
    heights: new Int16Array(regionGridSize(level) ** 2).fill(EMPTY_HEIGHT),
    minY: 0,
    maxY: 0,
    opaque: empty,
    plants: empty,
    translucent: empty,
    ...(textured ? { textures: { opaque: empty, plants: empty, translucent: empty } } : {}),
  });
}

function isValidRegion(bytes: Uint8Array, request: RegionRequest, textured: boolean): boolean {
  try {
    const region = decodeSceneRegion(bytes);
    return (
      region.level === request.level &&
      region.x === request.x &&
      region.z === request.z &&
      (region.textures !== undefined) === textured
    );
  } catch {
    return false;
  }
}

/** Region decoding needs a four-byte aligned start. */
function aligned(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
