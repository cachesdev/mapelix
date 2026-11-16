import {
  createBedrockWorld,
  openBedrockWorld,
  type BedrockWorld,
  type BedrockWorldDirectory,
  type EffectiveBedrockRecord,
} from "@mapelix/prototype";

import { surfaceProfile } from "../surface-profiles.js";
import type { MapWorld } from "../types.js";

export type { BedrockWorldDirectory as MapWorldDirectory, EffectiveBedrockRecord };

/** Adapts the reference renderer without coupling the portable profile entry to Node. */
function withSurfaceProfiles(world: BedrockWorld): MapWorld {
  return {
    async renderTile(coordinates, options = {}) {
      const { topY, ...renderOptions } = options;
      const profile = surfaceProfile(coordinates.dimension, topY);
      return world.renderTile(coordinates, { ...renderOptions, surfaceRange: profile });
    },
    getTileCoverage(dimension) {
      return world.getTileCoverage(surfaceProfile(dimension).dimension);
    },
    close: (options) => world.close(options),
  };
}

export function createMapWorld(records: Iterable<EffectiveBedrockRecord>): MapWorld {
  return withSurfaceProfiles(createBedrockWorld(records));
}

export async function openMapWorld(input: BedrockWorldDirectory): Promise<MapWorld> {
  return withSurfaceProfiles(await openBedrockWorld(input));
}
