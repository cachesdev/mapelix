import { MAX_REGION_LEVEL } from "./format.js";
import type { BlockRequest } from "./node/worker-protocol.js";
import type { RegionRequest } from "./node/region-builder.js";
import { RegionWorkerPool, type BuiltRegion } from "./node/worker-pool.js";
import type { Dimension } from "./world/chunk-source.js";
import { readLevelInfo, type LevelInfo } from "./world/level-info.js";
import { CAVE_LIMITS, parseDimension, sceneContext } from "./dimensions.js";
import { assertDiscoveryRequest, type DiscoveryRequest } from "./discoveries.js";

export type { BuiltRegion } from "./node/worker-pool.js";
export type { RegionRequest } from "./node/region-builder.js";
export type { PaletteTextures } from "./mesh/block-palette.js";
export type { Dimension } from "./world/chunk-source.js";
export type { LevelInfo } from "./world/level-info.js";

export interface SceneWorldOptions {
  /** An extracted Bedrock world directory, the one that holds `db` and `level.dat`. */
  readonly directory: string;
  readonly dimension?: Dimension;
  /** Worker threads that build regions in parallel. */
  readonly workers?: number;
}

export interface SceneWorld {
  readonly info: LevelInfo;
  /** Builds one serialized region. See `@mapelix/scene-prototype/format` for the layout. */
  buildRegion(request: RegionRequest, signal?: AbortSignal): Promise<BuiltRegion>;
  /** Encodes all-height source discoveries; adapters namespace by snapshot and detector schema. */
  buildDiscoveries(request: DiscoveryRequest, signal?: AbortSignal): Promise<BuiltRegion>;
  /** The block at one position as JSON `{ name, states }`; `name` is null where nothing loads. */
  readBlock(request: BlockRequest, signal?: AbortSignal): Promise<BuiltRegion>;
  close(): Promise<void>;
}

/**
 * Opens a Bedrock world for 3D streaming. Workers read the LevelDB tables by
 * block on demand, so opening does not scan the whole database.
 */
export async function openSceneWorld(options: SceneWorldOptions): Promise<SceneWorld> {
  const workers = options.workers ?? 2;
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new RangeError(`workers must be a positive integer, received ${workers}`);
  }
  const info = await readLevelInfo(options.directory);
  const dimension = parseDimension(options.dimension);
  const pool = new RegionWorkerPool({ directory: options.directory, dimension }, workers);
  return {
    info,
    buildRegion(request, signal) {
      assertRegionRequest(request);
      const context = sceneContext(dimension, request);
      if (context.mode === "caves" && request.level > CAVE_LIMITS.maxLevel) {
        throw new RangeError(`Caves support LOD 0 through ${CAVE_LIMITS.maxLevel}`);
      }
      return pool.build(request, signal);
    },
    close: () => pool.close(),
    readBlock(request, signal) {
      const { x, y, z } = request;
      if (![x, y, z].every(Number.isSafeInteger))
        throw new RangeError(`Block coordinates must be integers, received ${x}, ${y}, ${z}`);
      return pool.block(request, signal);
    },
    buildDiscoveries(request, signal) {
      assertDiscoveryRequest(request);
      return pool.discoveries(request, signal);
    },
  };
}

function assertRegionRequest({ level, x, z }: RegionRequest): void {
  if (!Number.isSafeInteger(level) || level < 0 || level > MAX_REGION_LEVEL) {
    throw new RangeError(`Region level must be 0 through ${MAX_REGION_LEVEL}, received ${level}`);
  }
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z)) {
    throw new RangeError(`Region coordinates must be integers, received ${x}, ${z}`);
  }
}
