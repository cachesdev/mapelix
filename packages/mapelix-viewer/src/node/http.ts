import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { MAX_REGION_LEVEL } from "@mapelix/scene-prototype/format";
import {
  CAVE_LIMITS,
  contextFromSearch,
  parseDimension,
} from "@mapelix/scene-prototype/dimensions";
import {
  assertDiscoveryRequest,
  DISCOVERY_SCHEMA_VERSION,
} from "@mapelix/scene-prototype/discoveries";

import type { LoadedRegion, SceneServer } from "./scene-world.js";

/** Answers a request it owns, or returns `undefined` so the host can route it elsewhere. */
export type MapelixHandler = (request: Request) => Promise<Response | undefined>;

const NO_STORE = { "cache-control": "no-store" };

function failure(status: number, message: string): Response {
  return Response.json({ message }, { status, headers: NO_STORE });
}

function cancelled(request: Request, cause: unknown): boolean {
  return request.signal.aborted || (cause instanceof Error && cause.name === "AbortError");
}

function binary(result: LoadedRegion, immutable: boolean, timing: string): Response {
  const { bytes } = result;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Response(body as ArrayBuffer, {
    headers: {
      "content-type": "application/octet-stream",
      // Clients add the world revision to the URL, so a response never changes in place.
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
      "server-timing": `${timing};dur=${result.milliseconds.toFixed(1)}`,
      "x-mapelix-cache": result.cacheStatus,
    },
  });
}

/** The path below `base`, or `undefined` when the request is not for this handler. */
function routePath(request: Request, base: string): string | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  const { pathname } = new URL(request.url);
  const prefix = base.replace(/\/+$/, "");
  if (prefix !== "" && !pathname.startsWith(`${prefix}/`)) return undefined;
  return pathname.slice(prefix.length);
}

/**
 * Serves the 3D viewer endpoints below `base`: `world.json`, `regions/<level>/<x>/<z>` and
 * `discoveries/<x>/<z>.bin`, each with the scene context in the query string.
 */
export function createSceneHandler(server: SceneServer, base = ""): MapelixHandler {
  return async (request) => {
    const path = routePath(request, base);
    if (path === undefined) return undefined;
    const url = new URL(request.url);
    if (path === "/world.json") {
      let context;
      try {
        context = contextFromSearch(url.searchParams);
      } catch (cause) {
        return failure(400, cause instanceof Error ? cause.message : "Invalid scene context");
      }
      return Response.json(await server.getWorldMetadata(context), { headers: NO_STORE });
    }
    const region = /^\/regions\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (region !== null) return regionResponse(server, request, url, region);
    const discovery = /^\/discoveries\/([^/]+)\/([^/]+)\.bin$/.exec(path);
    if (discovery !== null) return discoveryResponse(server, request, url, discovery);
    return undefined;
  };
}

async function regionResponse(
  server: SceneServer,
  request: Request,
  url: URL,
  [, rawLevel, rawX, rawZ]: RegExpExecArray,
): Promise<Response> {
  let context;
  try {
    context = contextFromSearch(url.searchParams);
  } catch (cause) {
    return failure(400, cause instanceof Error ? cause.message : "Invalid scene context");
  }
  const level = Number(rawLevel),
    x = Number(rawX),
    z = Number(rawZ);
  if (!Number.isInteger(level) || level < 0 || level > MAX_REGION_LEVEL)
    return failure(400, `Region level must be an integer from 0 through ${MAX_REGION_LEVEL}`);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(z))
    return failure(400, "Region coordinates must be integers");
  if (context.mode === "caves" && level > CAVE_LIMITS.maxLevel)
    return failure(400, `Caves support LOD 0 through ${CAVE_LIMITS.maxLevel}`);
  const revision = url.searchParams.get("revision");
  if (revision !== null && revision !== (await server.getWorldMetadata(context)).revision)
    return failure(409, "World revision changed; reload world metadata");
  try {
    const loaded = await server.loadRegion({ level, x, z }, request.signal, context);
    return binary(loaded, revision !== null, "region");
  } catch (cause) {
    if (cancelled(request, cause)) return new Response(null, { status: 499, headers: NO_STORE });
    throw cause;
  }
}

async function discoveryResponse(
  server: SceneServer,
  request: Request,
  url: URL,
  [, rawX, rawZ]: RegExpExecArray,
): Promise<Response> {
  let dimension;
  const tile = { x: Number(rawX), z: Number(rawZ) };
  try {
    dimension = parseDimension(url.searchParams.get("dimension"));
    assertDiscoveryRequest(tile);
    for (const name of url.searchParams.keys())
      if (!["dimension", "revision", "schema"].includes(name))
        throw new RangeError("Discovery indexes have no view, filter or selection parameters");
    const schema = url.searchParams.get("schema");
    if (schema !== null && schema !== String(DISCOVERY_SCHEMA_VERSION))
      throw new RangeError("Unsupported discovery schema");
  } catch (cause) {
    return failure(400, cause instanceof Error ? cause.message : "Invalid discovery request");
  }
  const revision = url.searchParams.get("revision");
  if (revision !== null && revision !== (await server.getSnapshotRevision()))
    return failure(409, "Snapshot revision changed; reload metadata");
  try {
    const result = await server.loadDiscoveries(dimension, tile, request.signal);
    return binary(result, revision !== null, "discoveries");
  } catch (cause) {
    if (cancelled(request, cause)) return new Response(null, { status: 499, headers: NO_STORE });
    throw cause;
  }
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const MAX_TILE_FILE = 128 * 1024 * 1024;

/**
 * Serves a `mapelix-render` output folder below `base`: the root `manifest.json`, which
 * changes on every publication, and the immutable `generations/<sha256>/…` files. Paths
 * that leave the folder, through `..` or a link, are refused.
 */
export function createTileHandler(directory: string, base = ""): MapelixHandler {
  const root = resolve(directory);
  // Kept only once resolved: the export folder may appear after the host starts.
  let realRoot: string | undefined;
  return async (request) => {
    const path = routePath(request, base);
    if (path === undefined) return undefined;
    const segments = path.split("/").slice(1);
    const manifest = segments.length === 1 && segments[0] === "manifest.json";
    const generation =
      segments.length > 2 && segments[0] === "generations" && /^[0-9a-f]{64}$/.test(segments[1]!);
    if (!manifest && !generation) return undefined;
    if (!segments.every((segment) => SEGMENT.test(segment))) return failure(400, "Invalid path");
    try {
      realRoot ??= await realpath(root);
      const real = await realpath(resolve(root, ...segments));
      if (!real.startsWith(`${realRoot}${sep}`)) return failure(404, "Not found");
      const details = await stat(real);
      if (!details.isFile() || details.size > MAX_TILE_FILE) return failure(404, "Not found");
      const bytes = request.method === "HEAD" ? undefined : await readFile(real);
      return new Response(bytes === undefined ? null : new Uint8Array(bytes), {
        headers: {
          "content-type": real.endsWith(".png")
            ? "image/png"
            : real.endsWith(".json")
              ? "application/json"
              : "application/octet-stream",
          "content-length": String(details.size),
          "cache-control": manifest ? "no-cache" : "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return failure(404, "Not found");
    }
  };
}
