import { hasWorld, textureUploads } from "$lib/server/world";

/**
 * `MAPELIX_MARKERS=spawn` starts with the world spawn only instead of the example markers, and
 * `MAPELIX_WORLD_ID` keeps the markers of each world apart in the browser.
 */
const markers = process.env.MAPELIX_MARKERS === "spawn" ? "spawn" : "examples";
const worldId = process.env.MAPELIX_WORLD_ID ?? "";

export const load = () => ({
  world: hasWorld,
  texturePacks: hasWorld && textureUploads,
  markers,
  worldId,
});
