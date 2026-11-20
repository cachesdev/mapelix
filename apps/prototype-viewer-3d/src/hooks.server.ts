import type { Handle } from "@sveltejs/kit";
import { handleScene } from "$lib/server/scene";

export const handle: Handle = async ({ event, resolve }) =>
  (await handleScene(event.request)) ?? resolve(event);
