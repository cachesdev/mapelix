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

/** The stack chosen last, so the demo keeps it after a restart. */
const CURRENT_FILE = "current.json";
/** Files this manager writes, and so may remove. */
const PACK_FILE = /^(?:upload|vanilla)-[0-9a-f-]+\.zip$/;
const LEFTOVER = /^(?:upload|vanilla)-[0-9a-f-]+\.zip(?:\.[0-9a-f-]+\.tmp)?$/;

/** One pack of the stack: its file in the pack folder and the name it was uploaded under. */
export interface StackEntry {
  readonly file: string;
  readonly label: string;
}

export interface TexturePackOptions {
  /** Where uploaded and downloaded packs are kept; only files this manager names are removed. */
  readonly directory: string;
  /** Largest pack accepted, uploaded or downloaded. */
  readonly maxBytes: number;
  /** Where the vanilla pack is downloaded from. */
  readonly vanillaUrl: string;
}

/** The stack chosen in an earlier run, highest priority first, if its files are still there. */
export function storedTextureStack(directory: string): StackEntry[] {
  try {
    const stored = JSON.parse(readFileSync(join(directory, CURRENT_FILE), "utf8")) as {
      pack?: unknown;
      packs?: unknown;
    };
    // An earlier version kept a single pack.
    const list: unknown[] = Array.isArray(stored.packs)
      ? stored.packs
      : typeof stored.pack === "string"
        ? [{ file: stored.pack }]
        : [];
    return list.flatMap((item) => {
      const { file, label } = (item ?? {}) as { file?: unknown; label?: unknown };
      if (typeof file !== "string" || !PACK_FILE.test(file)) return [];
      try {
        if (!statSync(join(directory, file)).isFile()) return [];
      } catch {
        return [];
      }
      const name =
        typeof label === "string" ? label.slice(0, 200) : isVanilla(file) ? "Vanilla" : file;
      return [{ file, label: name }];
    });
  } catch {
    return [];
  }
}

/** A vanilla pack, downloaded from this address or another. */
const isVanilla = (file: string): boolean => file.startsWith("vanilla-");

class PackTooLargeError extends Error {}

/**
 * Lets the demo change the scene server's texture stack while it runs. The stack is a list of
 * packs, highest priority first: a block takes its textures from the first pack that has them,
 * so a pack added on top wins over the vanilla pack below it. Packs are uploaded (zip or
 * `.mcpack`), or the vanilla pack is downloaded once; the list can be reordered or emptied. The
 * scene server checks every stack with its own limits before it switches: a refused stack
 * changes nothing, and an image a pack holds but the server cannot use (too large, damaged)
 * is skipped alone and taken from the next pack. For the demo only: a host puts this behind
 * its own access control, or uses `SceneServer.setTextures` its own way.
 */
export function createTexturePacks(server: SceneServer, options: TexturePackOptions) {
  const vanillaName = `vanilla-${createHash("sha256").update(options.vanillaUrl).digest("hex").slice(0, 16)}.zip`;
  let entries: readonly StackEntry[] = storedTextureStack(options.directory);
  let report: TextureStackReport | undefined;
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

  /**
   * Switches to `next`. On success it is kept for the next start and the uploads it no longer
   * holds leave the folder; a refused stack changes nothing, and `added` is removed.
   */
  async function use(next: readonly StackEntry[], added?: string): Promise<TextureStackReport> {
    const result = await server.setTextures(
      next.length === 0
        ? null
        : { packs: next.map((entry) => join(options.directory, entry.file)) },
    );
    if (!result.ok) {
      if (added !== undefined && added !== vanillaName)
        await rm(join(options.directory, added), { force: true });
      return result;
    }
    entries = next;
    report = result;
    await mkdir(options.directory, { recursive: true });
    await writeFile(join(options.directory, CURRENT_FILE), JSON.stringify({ packs: next }));
    await removeUnused();
    return result;
  }

  /** Uploads the stack no longer holds, and vanilla packs from another address, leave. */
  async function removeUnused(): Promise<void> {
    const keep = new Set([vanillaName, ...entries.map((entry) => entry.file)]);
    for (const entry of await readdir(options.directory).catch(() => [] as string[])) {
      if (!keep.has(entry) && LEFTOVER.test(entry))
        await rm(join(options.directory, entry), { force: true });
    }
  }

  /** Adds an uploaded pack on top of the stack, where it wins over the packs below. */
  async function upload(
    body: ReadableStream<Uint8Array>,
    label: string,
  ): Promise<TextureStackReport> {
    return serialized("upload", async () => {
      const file = `upload-${randomUUID()}.zip`;
      await save(body, file);
      return use([{ file, label }, ...entries], file);
    });
  }

  /** Downloads the vanilla pack once, then puts it at the bottom of the stack. */
  async function vanilla(): Promise<TextureStackReport> {
    return serialized("vanilla", async () => {
      const present = await readdir(options.directory).catch(() => [] as string[]);
      if (!present.includes(vanillaName)) {
        const response = await fetch(options.vanillaUrl, { redirect: "follow" });
        if (!response.ok || response.body === null)
          throw new Error(`The vanilla pack could not be downloaded (${response.status})`);
        await save(response.body, vanillaName);
      }
      return use(
        [
          ...entries.filter((entry) => !isVanilla(entry.file)),
          { file: vanillaName, label: "Vanilla" },
        ],
        vanillaName,
      );
    });
  }

  /** Keeps the packs `files` names, in that order; the others leave the stack. */
  async function arrange(files: readonly string[]): Promise<TextureStackReport> {
    return serialized("arrange", async () => {
      const next = files.map((file) => {
        const entry = entries.find((candidate) => candidate.file === file);
        if (entry === undefined) throw new RangeError(`The stack holds no pack ${file}`);
        return entry;
      });
      if (new Set(files).size !== files.length) throw new RangeError("A pack is listed twice");
      return use(next);
    });
  }

  /** Removes every pack: blocks keep their colors. */
  async function remove(): Promise<TextureStackReport> {
    return serialized("remove", () => use([]));
  }

  /** The stack, what the server serves and its last report: packs, skipped images. */
  async function status() {
    // A stack used since the start has no report yet: the same stack again builds nothing.
    if (report === undefined && entries.length > 0 && busy === undefined) {
      const current = entries;
      report = await serialized("check", () =>
        server.setTextures({ packs: current.map((entry) => join(options.directory, entry.file)) }),
      );
    }
    const metadata = await server.getWorldMetadata();
    return {
      stack: entries.map((entry, index) => ({
        ...entry,
        vanilla: isVanilla(entry.file),
        pack: report?.ok === true ? (report.packs?.[index] ?? null) : null,
      })),
      textures: metadata.textures ?? null,
      skipped: report?.skipped ?? [],
      errors: report?.ok === false ? report.errors : [],
      busy: busy ?? null,
      maxBytes: options.maxBytes,
      vanillaUrl: options.vanillaUrl,
    };
  }

  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } });

  const reply = async (task: () => Promise<TextureStackReport>) => {
    try {
      const result = await task();
      return json(result, result.ok ? 200 : 422);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return json({ ok: false, errors: [message] }, cause instanceof RangeError ? 400 : 500);
    }
  };

  /**
   * On `path`: `GET` the status; `POST` a pack to add on top (its name in `x-mapelix-pack-name`),
   * or `?source=vanilla` to add the vanilla pack at the bottom; `PUT` `{ "packs": [file, ...] }`
   * to reorder or drop packs; `DELETE` to remove them all. Changes need an `x-mapelix-demo`
   * header, which another site's page cannot send without asking first.
   */
  function handler(path: string) {
    return async (request: Request): Promise<Response | undefined> => {
      const url = new URL(request.url);
      if (url.pathname !== path) return undefined;
      if (request.method === "GET") return json(await status());
      if (request.headers.get("x-mapelix-demo") !== "1")
        return json({ message: "Missing x-mapelix-demo header" }, 403);
      if (request.method === "DELETE") return reply(remove);
      if (request.method === "PUT") {
        const text = await request.text();
        if (text.length > 64 * 1024) return json({ ok: false, errors: ["Too long"] }, 413);
        let files: unknown;
        try {
          files = (JSON.parse(text) as { packs?: unknown }).packs;
        } catch {
          files = undefined;
        }
        if (!Array.isArray(files) || !files.every((file) => typeof file === "string"))
          return json({ ok: false, errors: ["Expected { packs: [file, ...] }"] }, 400);
        return reply(() => arrange(files as string[]));
      }
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "GET, POST, PUT, DELETE" } });
      if (url.searchParams.get("source") === "vanilla") return reply(vanilla);
      const body = request.body;
      if (body === null) return json({ ok: false, errors: ["No pack was sent"] }, 400);
      const length = Number(request.headers.get("content-length") ?? "0");
      if (length > options.maxBytes)
        return json(
          { ok: false, errors: [`The pack is larger than ${options.maxBytes} bytes`] },
          413,
        );
      let label = "Uploaded pack";
      try {
        label = decodeURIComponent(request.headers.get("x-mapelix-pack-name") ?? "") || label;
      } catch {
        /* Keep the default name. */
      }
      return reply(() => upload(body, label.slice(0, 200)));
    };
  }

  return {
    upload,
    vanilla,
    arrange,
    remove,
    status,
    handler,
    /** The packs of the stack, highest priority first, as paths. */
    get packs(): string[] {
      return entries.map((entry) => join(options.directory, entry.file));
    },
  };
}
