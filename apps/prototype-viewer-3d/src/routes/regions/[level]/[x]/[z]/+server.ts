import { error } from "@sveltejs/kit";
import { MAX_REGION_LEVEL } from "@mapelix/scene-prototype/format";

import { loadRegion } from "$lib/server/scene-world";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params, request }) => {
  const level = Number(params.level);
  const x = Number(params.x);
  const z = Number(params.z);
  if (!Number.isInteger(level) || level < 0 || level > MAX_REGION_LEVEL) {
    error(400, `Region level must be an integer from 0 through ${MAX_REGION_LEVEL}`);
  }
  if (!Number.isInteger(x) || !Number.isInteger(z)) {
    error(400, "Region coordinates must be integers");
  }

  const region = await loadRegion({ level, x, z }, request.signal);
  const { bytes } = region;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Response(body as ArrayBuffer, {
    headers: {
      "content-type": "application/octet-stream",
      // The client adds the world revision to the URL, so a region never changes in place.
      "cache-control": "public, max-age=31536000, immutable",
      "server-timing": `region;dur=${region.milliseconds.toFixed(1)}`,
      "x-mapelix-cache": region.cacheStatus,
    },
  });
};
