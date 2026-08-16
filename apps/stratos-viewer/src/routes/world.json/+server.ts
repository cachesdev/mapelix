import { getStratosMetadata } from "$lib/server/stratos";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  return Response.json(await getStratosMetadata(), {
    headers: { "cache-control": "no-store" },
  });
};
