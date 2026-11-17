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

import { InvalidRegionError, NotCachedError, OverloadedError } from "./region-service.js";
import { MissingWorldError, type LoadedRegion, type SceneServer } from "./scene-world.js";

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

export interface SceneHandlerOptions {
  /**
   * Serve Surface regions from the cache only: one not built yet answers 404 `not-cached` (a
   * prewarm builds them). For an anonymous or public front end.
   */
  readonly cacheOnly?: boolean;
  /**
   * With `cacheOnly`: cave slices and discovery indexes may still be built, at most this many
   * requests at once through this handler (503 beyond). 0, the default, serves them from the
   * cache only too.
   */
  readonly maxBuilds?: number;
}

/** Turns the server's typed refusals into JSON answers; anything else goes to the host. */
function refusal(request: Request, cause: unknown): Response {
  if (cancelled(request, cause)) return new Response(null, { status: 499, headers: NO_STORE });
  if (cause instanceof InvalidRegionError) return failure(400, cause.message);
  if (cause instanceof NotCachedError)
    return Response.json(
      { error: "not-cached", message: cause.message },
      { status: 404, headers: NO_STORE },
    );
  if (cause instanceof OverloadedError) return overloaded();
  if (cause instanceof MissingWorldError) return failure(503, cause.message);
  throw cause;
}

function overloaded(): Response {
  return Response.json(
    { error: "overloaded", message: "Too many builds are waiting; retry shortly" },
    { status: 503, headers: { ...NO_STORE, "retry-after": "2" } },
  );
}

/** Whether a request may build, and how it gives its slot back; or the refusal. */
type Admission = { readonly cacheOnly: boolean; readonly release: () => void } | Response;
type Admit = (buildable: boolean) => Admission;

/**
 * Serves the 3D viewer endpoints below `base`: `world.json`, `regions/<level>/<x>/<z>`,
 * `discoveries/<x>/<z>.bin` and, with a texture stack, `textures/<revision>/atlas.bin` and
 * `textures/<revision>/notices.json`; regions and discoveries take the scene context in the
 * query string. A request outside the stored world gets an empty payload
 * (`x-mapelix-cache: empty`), too many waiting builds a 503 with `retry-after`, and a missing
 * world a 503.

 */
export function createSceneHandler(
  server: SceneServer,
  base = "",
  options: SceneHandlerOptions = {},
): MapelixHandler {
  const maxBuilds = options.maxBuilds ?? 0;
  if (!Number.isSafeInteger(maxBuilds) || maxBuilds < 0)
    throw new RangeError("maxBuilds must be a whole number");
  let building = 0;
  const admit: Admit = (buildable) => {
    if (options.cacheOnly !== true) return { cacheOnly: false, release: () => undefined };
    if (!buildable || maxBuilds === 0) return { cacheOnly: true, release: () => undefined };
    if (building >= maxBuilds) return overloaded();
    building += 1;
    let released = false;
    return {
      cacheOnly: false,
      release: () => {
        if (released) return;
        released = true;
        building -= 1;
      },
    };
  };
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
      try {
        return Response.json(await server.getWorldMetadata(context), { headers: NO_STORE });
      } catch (cause) {
        return refusal(request, cause);
      }
    }
    const texture = /^\/textures\/([0-9a-f]{20})\/(atlas\.bin|notices\.json)$/.exec(path);
    if (texture !== null) return textureResponse(server, request, texture, options);
    const region = /^\/regions\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(path);
    if (region !== null) return regionResponse(server, request, url, region, admit, options);
    const discovery = /^\/discoveries\/([^/]+)\/([^/]+)\.bin$/.exec(path);
    if (discovery !== null) return discoveryResponse(server, request, url, discovery, admit);
    return undefined;
  };
}

const IMMUTABLE = "public, max-age=31536000, immutable";

/**
 * The atlas of a texture revision, Brotli- or gzip-encoded when the client accepts it, and the
 * notices of the packs and files it was made of. The revision names the content, so neither
 * ever changes in place. A cache-only handler never builds the atlas: 404 until it is stored.
 */
async function textureResponse(
  server: SceneServer,
  request: Request,
  [, revision, file]: RegExpExecArray,
  options: SceneHandlerOptions,
): Promise<Response> {
  let atlas;
  try {
    atlas = await server.loadTextureAtlas(revision!, { cacheOnly: options.cacheOnly === true });
  } catch (cause) {
    if (
      cancelled(request, cause) ||
      !(cause instanceof Error) ||
      cause.name === "MissingWorldError"
    )
      return refusal(request, cause);
    return failure(503, `Textures are unavailable: ${cause.message}`);
  }
  if (atlas === undefined) {
    return Response.json(
      { error: "not-cached", message: "No such texture atlas, or it is not built yet" },
      { status: 404, headers: NO_STORE },
    );
  }
  if (file === "notices.json") {
    return Response.json(atlas.notices, { headers: { "cache-control": IMMUTABLE } });
  }
  const accepted = request.headers.get("accept-encoding") ?? "";
  const encoding = /\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : undefined;
  const bytes = encoding === "br" ? atlas.brotli : encoding === "gzip" ? atlas.gzip : atlas.bytes;
  const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Response(request.method === "HEAD" ? null : (body as ArrayBuffer), {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(bytes.byteLength),
      ...(encoding === undefined ? {} : { "content-encoding": encoding }),
      vary: "accept-encoding",
      "cache-control": IMMUTABLE,
    },
  });
}

/** Runs a load with an admission slot, and answers its refusals. */
async function admitted(
  request: Request,
  admit: Admit,
  buildable: boolean,
  load: (cacheOnly: boolean) => Promise<Response>,
): Promise<Response> {
  const admission = admit(buildable);
  if (admission instanceof Response) return admission;
  try {
    return await load(admission.cacheOnly);
  } catch (cause) {
    return refusal(request, cause);
  } finally {
    admission.release();
  }
}

async function regionResponse(
  server: SceneServer,
  request: Request,
  url: URL,
  [, rawLevel, rawX, rawZ]: RegExpExecArray,
  admit: Admit,
  options: SceneHandlerOptions,
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
  const textures = url.searchParams.get("textures");
  const cutoutParam = url.searchParams.get("cutout");
  if (cutoutParam !== null && (cutoutParam !== "1" || textures === null))
    return failure(400, "cutout=1 needs a texture revision");
  const cutout = cutoutParam === "1";
  if (textures !== null) {
    if (!/^[0-9a-f]{20}$/.test(textures)) return failure(400, "Invalid texture revision");
    if (level !== 0) return failure(400, "Textured regions are level 0 only");
    if (context.mode !== "surface") return failure(400, "Textured regions are Surface only");
  }
  try {
    if (revision !== null && revision !== (await server.getRevision()))
      return failure(409, "World revision changed; reload world metadata");
    if (textures !== null && textures !== (await server.getTextureRevision()))
      return failure(409, "Texture revision changed; reload world metadata");
  } catch (cause) {
    return refusal(request, cause);
  }
  // Surface regions come from the prewarm; cave slices may be built on demand. A cache-only
  // handler never builds a textured region.
  if (textures !== null && options.cacheOnly === true) {
    return admitted(
      request,
      () => ({ cacheOnly: true, release: () => undefined }),
      false,
      async () =>
        binary(
          await server.loadRegion({ level, x, z }, request.signal, context, {
            cacheOnly: true,
            textures,
            ...(cutout ? { cutout } : {}),
          }),
          revision !== null,
          "region",
        ),
    );
  }
  return admitted(request, admit, context.mode === "caves", async (cacheOnly) =>
    binary(
      await server.loadRegion({ level, x, z }, request.signal, context, {
        cacheOnly,
        ...(textures === null ? {} : { textures }),
        ...(cutout ? { cutout } : {}),
      }),
      revision !== null,
      "region",
    ),
  );
}

async function discoveryResponse(
  server: SceneServer,
  request: Request,
  url: URL,
  [, rawX, rawZ]: RegExpExecArray,
  admit: Admit,
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
  try {
    if (revision !== null && revision !== (await server.getSnapshotRevision()))
      return failure(409, "Snapshot revision changed; reload metadata");
  } catch (cause) {
    return refusal(request, cause);
  }
  return admitted(request, admit, true, async (cacheOnly) =>
    binary(
      await server.loadDiscoveries(dimension, tile, request.signal, { cacheOnly }),
      revision !== null,
      "discoveries",
    ),
  );
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
