import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SceneServer, TextureStackReport } from "@mapelix/viewer/node";

/** The vanilla resource pack of Mojang's Bedrock samples, which the scene server reads as is. */
export const DEFAULT_VANILLA_PACK_URL =
  "https://github.com/Mojang/bedrock-samples/releases/download/v1.26.60.5/bedrock-samples-v1.26.60.5-full.zip";

/** The pack chosen last, so the demo keeps it after a restart. */
const CURRENT_FILE = "current.json";

export interface TexturePackOptions {
  /** Where uploaded and downloaded packs are kept; only files this manager names are removed. */
  readonly directory: string;
  /** Largest pack accepted, uploaded or downloaded. */
  readonly maxBytes: number;
  /** Where the vanilla pack is downloaded from. */
  readonly vanillaUrl: string;
}

/** The pack chosen in an earlier run, if its file is still there. */
export function storedTexturePack(directory: string): string | undefined {
  try {
    const { pack } = JSON.parse(readFileSync(join(directory, CURRENT_FILE), "utf8")) as {
      pack?: unknown;
    };
    if (typeof pack !== "string" || !/^(?:upload|vanilla)-[0-9a-f-]+\.zip$/.test(pack))
      return undefined;
    const path = join(directory, pack);
    return statSync(path).isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

class PackTooLargeError extends Error {}

/**
 * Lets the demo change the scene server's texture pack while it runs: upload a zip or
 * `.mcpack`, download the vanilla pack, or remove the textures. The scene server checks every
 * pack with its own limits before it switches; a refused pack changes nothing. For the demo
 * only: a host puts this behind its own access control, or uses `SceneServer.setTextures` its
 * own way.
 */
export function createTexturePacks(server: SceneServer, options: TexturePackOptions) {
  const vanillaName = `vanilla-${createHash("sha256").update(options.vanillaUrl).digest("hex").slice(0, 16)}.zip`;
  let queue: Promise<unknown> = Promise.resolve();
  let busy: string | undefined;

  /** One change at a time; later ones wait their turn. */
  function serialized<T>(label: string, task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
      busy = label;
      try {
        return await task();
      } finally {
        busy = undefined;
      }
    });
    queue = run.catch(() => undefined);
    return run;
  }

  /** Writes a body to `name` in the pack folder, refusing it past `maxBytes`. */
  async function save(body: ReadableStream<Uint8Array>, name: string): Promise<string> {
    await mkdir(options.directory, { recursive: true });
    const path = join(options.directory, name);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let bytes = 0;
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes) callback(new PackTooLargeError());
        else callback(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(body as WebReadableStream<Uint8Array>),
        limit,
        createWriteStream(temporary),
      );
      if (bytes === 0) throw new Error("The pack is empty");
      await rename(temporary, path);
      return path;
    } catch (cause) {
      await rm(temporary, { force: true });
      if (cause instanceof PackTooLargeError)
        throw new Error(`The pack is larger than ${options.maxBytes} bytes`);
      throw cause;
    }
  }

  /** Switches to `name`; on success the other uploads leave the folder. */
  async function use(name: string): Promise<TextureStackReport> {
    const report = await server.setTextures({ packs: [join(options.directory, name)] });
    if (!report.ok) {
      if (name !== vanillaName) await rm(join(options.directory, name), { force: true });
      return report;
    }
    await writeFile(join(options.directory, CURRENT_FILE), JSON.stringify({ pack: name }));
    await removeOthers(name);
    return report;
  }

  /** Uploads other than `keep`, and vanilla packs from another address, leave the folder. */
  async function removeOthers(keep: string | undefined): Promise<void> {
    for (const entry of await readdir(options.directory).catch(() => [] as string[])) {
      if (entry === keep || entry === vanillaName || entry === CURRENT_FILE) continue;
      if (/^(?:upload|vanilla)-[0-9a-f-]+\.zip(?:\.[0-9a-f-]+\.tmp)?$/.test(entry))
        await rm(join(options.directory, entry), { force: true });
    }
  }

  async function upload(body: ReadableStream<Uint8Array>): Promise<TextureStackReport> {
    return serialized("upload", async () => {
      const name = `upload-${randomUUID()}.zip`;
      await save(body, name);
      return use(name);
    });
  }

  /** Downloads the vanilla pack once, then switches to it. */
  async function vanilla(): Promise<TextureStackReport> {
    return serialized("vanilla", async () => {
      const present = await readdir(options.directory).catch(() => [] as string[]);
      if (!present.includes(vanillaName)) {
        const response = await fetch(options.vanillaUrl, { redirect: "follow" });
        if (!response.ok || response.body === null)
          throw new Error(`The vanilla pack could not be downloaded (${response.status})`);
        await save(response.body, vanillaName);
      }
      return use(vanillaName);
    });
  }

  async function remove(): Promise<TextureStackReport> {
    return serialized("remove", async () => {
      const report = await server.setTextures(null);
      await rm(join(options.directory, CURRENT_FILE), { force: true });
      await removeOthers(undefined);
      return report;
    });
  }

  async function status() {
    const metadata = await server.getWorldMetadata();
    return {
      textures: metadata.textures ?? null,
      busy: busy ?? null,
      maxBytes: options.maxBytes,
      vanillaUrl: options.vanillaUrl,
    };
  }

  const reply = async (task: () => Promise<TextureStackReport>) => {
    try {
      const report = await task();
      return Response.json(report, {
        status: report.ok ? 200 : 422,
        headers: { "cache-control": "no-store" },
      });
    } catch (cause) {
      return Response.json(
        { ok: false, errors: [cause instanceof Error ? cause.message : String(cause)] },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };

  /**
   * `GET`, `POST` (the body is a pack; `?source=vanilla` downloads the vanilla pack instead)
   * and `DELETE` on `path`. Changes need an `x-mapelix-demo` header, which another site's
   * page cannot send without asking first.
   */
  function handler(path: string) {
    return async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      if (url.pathname !== path) return undefined;
      if (request.method === "GET")
        return Response.json(await status(), { headers: { "cache-control": "no-store" } });
      if (request.headers.get("x-mapelix-demo") !== "1")
        return Response.json({ message: "Missing x-mapelix-demo header" }, { status: 403 });
      if (request.method === "DELETE") return reply(remove);
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "GET, POST, DELETE" } });
      if (url.searchParams.get("source") === "vanilla") return reply(vanilla);
      const body = request.body;
      if (body === null)
        return Response.json({ ok: false, errors: ["No pack was sent"] }, { status: 400 });
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > options.maxBytes)
        return Response.json(
          { ok: false, errors: [`The pack is larger than ${options.maxBytes} bytes`] },
          { status: 413 },
        );
      return reply(() => upload(body));
    };
  }

  return { upload, vanilla, remove, status, handler };
}
