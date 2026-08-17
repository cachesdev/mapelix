import { getStratosMetadata } from "$lib/server/stratos";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async () => {
  const startedAt = performance.now();
  const result = await getStratosMetadata();
  return Response.json(result.metadata, {
    headers: {
      "cache-control": "no-store",
      "server-timing": `metadata;dur=${(performance.now() - startedAt).toFixed(2)}`,
      "x-mapelix-cache": result.cacheStatus,
    },
  });
};
