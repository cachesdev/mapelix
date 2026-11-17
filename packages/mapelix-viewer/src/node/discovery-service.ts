import type { Dimension } from "@mapelix/scene-prototype";
import {
  DISCOVERY_TILE_SPAN,
  assertDiscoveryRequest,
  decodeDiscoveryTile,
  encodeDiscoveryTile,
  type DiscoveryRequest,
} from "@mapelix/scene-prototype/discoveries";

import { ByteLru, Flights, isAbort } from "./build-cache.js";
import type { BlockBounds } from "./bounds.js";
import {
  InvalidRegionError,
  NotCachedError,
  type BuiltBytes,
  type LoadOptions,
  type RegionResult,
  type RegionStore,
} from "./region-service.js";

export type BuildDiscoveries = (
  dimension: Dimension,
  tile: DiscoveryRequest,
  signal: AbortSignal,
  background?: boolean,
) => Promise<BuiltBytes>;

export interface DiscoveryServiceOptions {
  readonly dimensions: ReadonlyMap<Dimension, BlockBounds | undefined>;
  readonly build: BuildDiscoveries;
  readonly store: RegionStore | undefined;
  readonly memoryBytes: number;
  readonly memoryEntries: number;
  readonly maxPending: number;
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

export interface DiscoveryServiceStats {
  readonly inFlight: number;
  readonly maxPending: number;
  readonly memoryEntries: number;
  readonly memoryBytes: number;
  readonly built: number;
  readonly rejected: number;
  readonly failed: number;
}

/**
 * Source indexes of notable blocks (ores, spawners, chests…), one per 32-block
 * column at every height. They depend only on the snapshot, never on the view, so
 * one index serves every cave slice, level and filter. A tile outside the stored
 * area is answered with an empty index without any build or disk write.
 */
export class DiscoveryService {
  private readonly options: DiscoveryServiceOptions;
  private readonly memory: ByteLru;
  private readonly flights: Flights<RegionResult>;
  private built = 0;
  private failed = 0;

  constructor(options: DiscoveryServiceOptions) {
    this.options = options;
    this.memory = new ByteLru(options.memoryBytes, options.memoryEntries);
    this.flights = new Flights(options.maxPending);
  }

  get stats(): DiscoveryServiceStats {
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
    tile: DiscoveryRequest,
    signal: AbortSignal,
    options: LoadOptions = {},
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    if (!this.options.dimensions.has(dimension)) {
      throw new InvalidRegionError(`Dimension ${dimension} is not served`);
    }
    try {
      assertDiscoveryRequest(tile);
    } catch (cause) {
      throw new InvalidRegionError(cause instanceof Error ? cause.message : String(cause));
    }
    const { x, z } = tile;
    const bounds = this.options.dimensions.get(dimension);
    if (bounds === undefined || !tileTouches(bounds, x, z)) {
      return {
        bytes: emptyDiscoveryBytes(dimension, x, z),
        cacheStatus: "empty",
        milliseconds: performance.now() - startedAt,
      };
    }
    const key = `${dimension}/${x}/${z}`;
    const remembered = this.memory.get(key);
    if (remembered !== undefined) {
      return {
        bytes: remembered,
        cacheStatus: "memory",
        milliseconds: performance.now() - startedAt,
      };
    }
    if (options.cacheOnly === true) {
      const stored = await this.readStored(key, dimension, tile);
      if (stored === undefined) throw new NotCachedError(`Discoveries ${key} are not built yet`);
      return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
    }
    return this.flights.join(
      key,
      (flightSignal) =>
        this.readOrBuild(key, dimension, { x, z }, flightSignal, options.background === true),
      signal,
    );
  }

  private async readOrBuild(
    key: string,
    dimension: Dimension,
    tile: DiscoveryRequest,
    signal: AbortSignal,
    background: boolean,
  ): Promise<RegionResult> {
    const startedAt = performance.now();
    const stored = await this.readStored(key, dimension, tile);
    if (stored !== undefined) {
      return { bytes: stored, cacheStatus: "disk", milliseconds: performance.now() - startedAt };
    }
    let built: BuiltBytes;
    try {
      built = await this.options.build(dimension, tile, signal, background);
    } catch (cause) {
      if (!isAbort(cause)) {
        this.failed += 1;
        this.options.onEvent?.("discoveries.build-failed", { key, message: String(cause) });
      }
      throw cause;
    }
    this.built += 1;
    const bytes = aligned(built.bytes);
    await this.options.store?.write(key, bytes);
    this.memory.set(key, bytes);
    return { bytes, cacheStatus: "build", milliseconds: built.milliseconds };
  }

  private async readStored(
    key: string,
    dimension: Dimension,
    tile: DiscoveryRequest,
  ): Promise<Uint8Array | undefined> {
    const store = this.options.store;
    const stored = await store?.read(key);
    if (stored === undefined) return undefined;
    const bytes = aligned(stored);
    if (isValidTile(bytes, dimension, tile)) {
      this.memory.set(key, bytes);
      return bytes;
    }
    this.options.onEvent?.("cache.discarded", { key });
    await store?.discard(key);
    return undefined;
  }
}

/** Whether a 32-block discovery tile overlaps the stored area. */
export function tileTouches(bounds: BlockBounds, x: number, z: number): boolean {
  const minX = x * DISCOVERY_TILE_SPAN;
  const minZ = z * DISCOVERY_TILE_SPAN;
  return (
    minX <= bounds.maxX &&
    minX + DISCOVERY_TILE_SPAN - 1 >= bounds.minX &&
    minZ <= bounds.maxZ &&
    minZ + DISCOVERY_TILE_SPAN - 1 >= bounds.minZ
  );
}

/** Every tile overlapping the stored area, nearest the middle first. */
export function discoveryTiles(bounds: BlockBounds): DiscoveryRequest[] {
  const span = DISCOVERY_TILE_SPAN;
  const centerX = (bounds.minX + bounds.maxX) / 2 / span;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2 / span;
  const tiles: (DiscoveryRequest & { distance: number })[] = [];
  for (let x = Math.floor(bounds.minX / span); x <= Math.floor(bounds.maxX / span); x += 1) {
    for (let z = Math.floor(bounds.minZ / span); z <= Math.floor(bounds.maxZ / span); z += 1) {
      tiles.push({ x, z, distance: (x - centerX) ** 2 + (z - centerZ) ** 2 });
    }
  }
  tiles.sort((left, right) => left.distance - right.distance);
  return tiles.map(({ x, z }) => ({ x, z }));
}

export function emptyDiscoveryBytes(dimension: Dimension, x: number, z: number): Uint8Array {
  return encodeDiscoveryTile({ dimension, x, z, sourceChunks: 0, blocks: new Uint32Array(0) });
}

function isValidTile(bytes: Uint8Array, dimension: Dimension, tile: DiscoveryRequest): boolean {
  try {
    const decoded = decodeDiscoveryTile(bytes);
    return decoded.dimension === dimension && decoded.x === tile.x && decoded.z === tile.z;
  } catch {
    return false;
  }
}

/** Decoders read 32-bit words from a four-byte aligned start. */
function aligned(bytes: Uint8Array): Uint8Array {
  if (bytes.byteOffset % 4 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
