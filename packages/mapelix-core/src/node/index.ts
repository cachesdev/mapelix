import {
  createBedrockWorld,
  openBedrockWorld,
  type BedrockWorld,
  type BedrockWorldDirectory,
  type EffectiveBedrockRecord,
} from "@mapelix/prototype";

import { surfaceProfile } from "../surface-profiles.js";
import { MODERN_SURFACE_STYLE } from "../surface-appearance.js";
import type { MapWorld } from "../types.js";

export type { BedrockWorldDirectory as MapWorldDirectory, EffectiveBedrockRecord };
export { createOverviewTile, type OverviewSourceTile } from "./overview.js";
export { decodePng, encodePng } from "@mapelix/prototype/png";
export {
  validateSnapshot,
  SNAPSHOT_VALIDATION_FORMAT,
  SNAPSHOT_VALIDATION_VERSION,
  type SnapshotValidationOptions,
  type SnapshotValidationResult,
  type SnapshotValidationIssue,
  type SnapshotValidationErrorCode,
} from "./snapshot.js";

/** Adapts the reference renderer without coupling the portable profile entry to Node. */
function withSurfaceProfiles(world: BedrockWorld): MapWorld {
  return {
    async renderTile(coordinates, options = {}) {
      const { topY, appearance = "modern", ...renderOptions } = options;
      if (appearance !== "modern" && appearance !== "reference") {
        throw new RangeError("Unsupported map appearance");
      }
      const profile = surfaceProfile(coordinates.dimension, topY);
      return world.renderTile(coordinates, {
        ...renderOptions,
        surfaceRange: profile,
        ...(appearance === "reference" ? {} : { surfaceStyle: MODERN_SURFACE_STYLE }),
      });
    },
    getTileCoverage(dimension) {
      return world.getTileCoverage(surfaceProfile(dimension).dimension);
    },
    ...(world.getChunkFingerprints === undefined
      ? {}
      : {
          getChunkFingerprints: (dimension: Parameters<MapWorld["getTileCoverage"]>[0]) =>
            world.getChunkFingerprints!(surfaceProfile(dimension).dimension),
        }),
    ...(world.getSurfaceCacheStats === undefined
      ? {}
      : { getSurfaceCacheStats: () => world.getSurfaceCacheStats!() }),
    close: (options) => world.close(options),
  };
}

export function createMapWorld(records: Iterable<EffectiveBedrockRecord>): MapWorld {
  return withSurfaceProfiles(createBedrockWorld(records));
}

export async function openMapWorld(input: BedrockWorldDirectory): Promise<MapWorld> {
  return withSurfaceProfiles(await openBedrockWorld(input));
}
