import type { Handle } from "@sveltejs/kit";
import { createTileHandler } from "@mapelix/viewer/node";
import { handleTexturePacks, handleWorld } from "$lib/server/world";

const directory = process.env.MAPELIX_TILES_DIRECTORY;
/** Serves a `mapelix-render` output folder at `/tiles`. */
const tiles = directory === undefined ? undefined : createTileHandler(directory, "/tiles");

export const handle: Handle = async ({ event, resolve }) =>
  (await tiles?.(event.request)) ??
  (await handleWorld?.(event.request)) ??
  (await handleTexturePacks?.(event.request)) ??
  resolve(event);
