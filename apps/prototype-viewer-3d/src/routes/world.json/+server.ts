import { getWorldMetadata } from "$lib/server/scene-world";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return Response.json(await getWorldMetadata(), { headers: { "cache-control": "no-store" } });
};
