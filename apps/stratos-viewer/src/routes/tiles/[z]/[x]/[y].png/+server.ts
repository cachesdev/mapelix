import { error } from "@sveltejs/kit";
import { MAX_NATIVE_ZOOM } from "@mapelix/core";

import { renderStratosTile } from "$lib/server/stratos";

import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ params }) => {
  const startedAt = performance.now();
  const z = Number(params.z);
  const x = Number(params.x);
  const y = Number(params.y);
  if (
    !Number.isInteger(z) ||
    z < 0 ||
    z > MAX_NATIVE_ZOOM ||
    !Number.isInteger(x) ||
    !Number.isInteger(y)
  ) {
    error(
      400,
      `Mapelix prototype tiles require integer coordinates from z0 through z${MAX_NATIVE_ZOOM}`,
    );
  }

  const result = await renderStratosTile(z, x, y);
  const png = result.png;
  const body = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
  return new Response(body, {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=31536000, immutable",
      "server-timing": `tile;dur=${(performance.now() - startedAt).toFixed(2)}`,
      "x-mapelix-cache": result.cacheStatus,
    },
  });
};
