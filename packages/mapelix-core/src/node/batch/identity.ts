import { createHash } from "node:crypto";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { MODERN_SURFACE_STYLE } from "../../surface-appearance.js";
import { assertNoLinks, isMissing } from "./paths.js";
import type { FileIdentity } from "./types.js";

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function jsonBytes(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function identifyFile(
  path: string,
  name: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<FileIdentity> {
  signal?.throwIfAborted();
  await assertNoLinks(path);
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`Not a regular source file: ${name}`);
    if (before.size > maxBytes)
      throw new RangeError(`File exceeds permitted bytes (${maxBytes}): ${name}`);
    const digest = createHash("sha256");
    const buffer = new Uint8Array(256 * 1024);
    let bytes = 0;
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer);
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes)
        throw new RangeError(`File exceeds permitted bytes (${maxBytes}): ${name}`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`Source changed while being read: ${name}`);
    }
    return { path: name, bytes, sha256: digest.digest("hex") };
  } finally {
    await file.close();
  }
}

export async function sourceIdentity(
  world: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ revision: string; files: FileIdentity[] }> {
  await assertNoLinks(join(world, "db"));
  const entries = await readdir(join(world, "db"), { withFileTypes: true });
  const names = entries
    .filter((entry) => /\.(ldb|sst|log)$/.test(entry.name))
    .map((entry) => `db/${entry.name}`)
    .sort();
  for (const name of ["level.dat"]) {
    try {
      await lstat(join(world, name));
      names.push(name);
    } catch (cause) {
      if (!isMissing(cause)) throw cause;
    }
  }
  names.sort();
  const files: FileIdentity[] = [];
  for (const name of names)
    files.push(await identifyFile(join(world, name), name, maxBytes, signal));
  return { revision: sha256(jsonBytes(files)), files };
}

export async function rendererIdentity(): Promise<{ revision: string; appearanceSha256: string }> {
  const digest = createHash("sha256");
  async function addTree(root: string, prefix: string): Promise<void> {
    async function visit(directory: string): Promise<void> {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".js")) {
          digest.update(`${prefix}/${relative(root, path).split(sep).join("/")}\0`);
          digest.update((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
          digest.update("\0");
        }
      }
    }
    await visit(root);
  }
  await addTree(fileURLToPath(new URL("../../", import.meta.url)), "core");
  await addTree(
    fileURLToPath(new URL("./", import.meta.resolve("@mapelix/prototype"))),
    "prototype",
  );
  digest.update(jsonBytes({ node: process.versions.node, zlib: process.versions.zlib }));
  return {
    revision: digest.digest("hex"),
    appearanceSha256: sha256(JSON.stringify(MODERN_SURFACE_STYLE)),
  };
}
