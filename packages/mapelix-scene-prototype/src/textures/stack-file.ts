import { lstat, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { ResourcePackError, packPath, type PackLimits } from "./pack-limits.js";

/**
 * A stack folder: a read-only folder a host prepares, holding the packs (folders, `.zip` or
 * `.mcpack` files) and `mapelix-stack.json`, which orders them:
 *
 * ```json
 * {
 *   "format": "mapelix-texture-stack",
 *   "version": 1,
 *   "packs": [
 *     { "path": "world/my_pack", "uuid": "…", "version": "1.2.0", "fingerprint": "…" },
 *     { "path": "vanilla.zip", "uuid": "…", "version": "1.21.0" }
 *   ]
 * }
 * ```
 *
 * See `docs/texture-stack.md` for every rule.
 */
export const STACK_FILE = "mapelix-stack.json";
export const STACK_FILE_FORMAT = "mapelix-texture-stack";
export const STACK_FILE_VERSION = 1;
const MAX_STACK_FILE_BYTES = 1024 * 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d{1,9}(\.\d{1,9}){0,7}$/;
const FINGERPRINT = /^[0-9a-f]{20}$/;

/** One pack of a stack file, its path resolved inside the folder. */
export interface StackFileEntry {
  readonly source: string;
  /** The path as the stack file writes it. */
  readonly path: string;
  readonly uuid: string;
  readonly version: string;
  /** The pack's `packFingerprint`, when the host pins it. */
  readonly fingerprint?: string;
}

/** Reads and checks `mapelix-stack.json` in `folder`; every path stays inside the folder. */
export async function readStackFile(
  folder: string,
  limits: Pick<PackLimits, "maxPacks">,
): Promise<StackFileEntry[]> {
  const label = basename(folder);
  const fail = (message: string): never => {
    throw new ResourcePackError(label, message, STACK_FILE);
  };
  const root = await lstat(folder).catch(() => undefined);
  if (root === undefined) throw new ResourcePackError(label, "is missing");
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new ResourcePackError(label, "is not a folder (a link is refused)");
  }
  const file = join(folder, STACK_FILE);
  const details = await lstat(file).catch(() => undefined);
  if (details === undefined) fail("is missing");
  if (details!.isSymbolicLink() || !details!.isFile()) fail("is not a file");
  if (details!.size > MAX_STACK_FILE_BYTES) fail(`is larger than ${MAX_STACK_FILE_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`is not valid JSON: ${(error as Error).message}`);
  }
  const body = parsed as Record<string, unknown> | null;
  if (typeof body !== "object" || body === null || Array.isArray(body)) fail("is not an object");
  if (body!["format"] !== STACK_FILE_FORMAT) fail(`has no format "${STACK_FILE_FORMAT}"`);
  if (body!["version"] !== STACK_FILE_VERSION) {
    fail(`has version ${String(body!["version"])}; this Mapelix reads ${STACK_FILE_VERSION}`);
  }
  const packs = body!["packs"];
  if (!Array.isArray(packs) || packs.length === 0) fail("lists no packs");
  if ((packs as unknown[]).length > limits.maxPacks) {
    fail(`lists more than ${limits.maxPacks} packs`);
  }

  const entries: StackFileEntry[] = [];
  const seen = new Set<string>();
  for (const [index, raw] of (packs as unknown[]).entries()) {
    const at = `packs[${index}]`;
    const entry = raw as Record<string, unknown> | null;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      fail(`${at} is not an object`);
    }
    const { path, uuid, version, fingerprint } = entry!;
    let safe: string | undefined;
    try {
      safe = typeof path === "string" ? packPath(path) : undefined;
    } catch (error) {
      fail(`${at}.path is unsafe: ${(error as Error).message}`);
    }
    if (safe === undefined) fail(`${at}.path is not a relative path to a pack`);
    if (typeof uuid !== "string" || !UUID.test(uuid)) fail(`${at}.uuid is not a UUID`);
    if (typeof version !== "string" || !VERSION.test(version)) {
      fail(`${at}.version is not a dotted version such as 1.2.0`);
    }
    if (
      fingerprint !== undefined &&
      (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint))
    ) {
      fail(`${at}.fingerprint is not 20 hexadecimal digits`);
    }
    const key = safe!.toLowerCase();
    if (seen.has(key)) fail(`${at}.path lists the same pack twice`);
    seen.add(key);
    // No segment of the path may be a link, so the pack cannot lie outside the folder.
    let current = folder;
    for (const segment of safe!.split("/")) {
      current = join(current, segment);
      const step = await lstat(current).catch(() => undefined);
      if (step === undefined) fail(`${at}.path ${safe!} is missing`);
      if (step!.isSymbolicLink()) fail(`${at}.path ${safe!} goes through a link`);
    }
    entries.push({
      source: current,
      path: safe!,
      uuid: (uuid as string).toLowerCase(),
      version: version as string,
      ...(fingerprint === undefined ? {} : { fingerprint: fingerprint as string }),
    });
  }
  return entries;
}
