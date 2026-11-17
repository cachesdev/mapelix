import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REGION_FORMAT_VERSION } from "@mapelix/scene-prototype/format";

/** Revisions are short lowercase hex names, which also name the cache folders. */
export const REVISION_PATTERN = /^[0-9a-f]{20}$/;

/**
 * Fingerprints the engine code that builds regions. Any change to the mesher,
 * the decoders, or the format makes a new fingerprint, so a server upgrade never
 * serves regions cached by an older engine.
 */
export async function engineFingerprint(): Promise<string> {
  const hash = createHash("sha256");
  const roots = [
    dirname(fileURLToPath(import.meta.resolve("@mapelix/scene-prototype"))),
    dirname(fileURLToPath(import.meta.resolve("@mapelix/prototype"))),
  ];
  for (const root of roots) {
    for (const file of await javascriptFiles(root)) {
      hash.update(`${file.slice(root.length)}\0`);
      hash.update(await readFile(file));
    }
  }
  return hash.digest("hex");
}

async function javascriptFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await javascriptFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * Names one world snapshot as built by one engine. It hashes the database file
 * names, sizes, and modification times plus `level.dat`, without reading the
 * tables, and leaves out the folder path so a moved snapshot keeps its cache.
 */
export async function worldRevision(worldDirectory: string, engine: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(`scene-format-v${REGION_FORMAT_VERSION}\0${engine}\0`);
  const database = join(worldDirectory, "db");
  const names = (await readdir(database)).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const details = await stat(join(database, name), { bigint: true });
    if (!details.isFile()) continue;
    hash.update(`db/${name}\0${details.size}\0${details.mtimeNs}\n`);
  }
  const level = await stat(join(worldDirectory, "level.dat"), { bigint: true });
  hash.update(`level.dat\0${level.size}\0${level.mtimeNs}\n`);
  return hash.digest("hex").slice(0, 20);
}
