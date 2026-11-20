import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { openLevelDbSnapshot, LevelDbSnapshotError } from "@mapelix/prototype/node/leveldb";
import { assertNoLinks, isMissing } from "./batch/paths.js";
import type { FileIdentity } from "./batch/types.js";

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
  logicalBytes?: number,
): Promise<FileIdentity> {
  signal?.throwIfAborted();
  await assertNoLinks(path);
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`Not a regular source file: ${name}`);
    const expectedBytes = logicalBytes ?? before.size;
    if (before.size < expectedBytes)
      throw new Error(`Source is shorter than its logical length: ${name}`);
    if (expectedBytes > maxBytes)
      throw new RangeError(`File exceeds permitted bytes (${maxBytes}): ${name}`);
    const digest = createHash("sha256");
    const buffer = new Uint8Array(256 * 1024);
    let bytes = 0;
    while (bytes < expectedBytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - bytes),
        null,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      if (bytes > maxBytes)
        throw new RangeError(`File exceeds permitted bytes (${maxBytes}): ${name}`);
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (
      bytes !== expectedBytes ||
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
  const snapshot = openLevelDbSnapshot(world, { maxFileBytes: maxBytes, signal });
  const sizes = new Map(snapshot.files.map((file) => [`db/${file.name}`, file.size]));
  const names = ["db/CURRENT", `db/${snapshot.manifestName}`, ...sizes.keys()];
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
    files.push(await identifyFile(join(world, name), name, maxBytes, signal, sizes.get(name)));
  for (const [name, bytes] of [
    ["CURRENT", snapshot.currentBytes],
    [snapshot.manifestName, snapshot.manifestBytes],
  ] as const) {
    if (files.find((file) => file.path === `db/${name}`)?.sha256 !== sha256(bytes))
      throw new LevelDbSnapshotError("SOURCE_CHANGED", name, "metadata changed after selection");
  }
  return { revision: sha256(jsonBytes(files)), files };
}
