import { lstat, readFile } from "node:fs/promises";

import { identifyFile, jsonBytes, sha256 } from "./identity.js";
import { assertNoLinks, assertTreeNoLinks, isMissing, ownedPath } from "./paths.js";
import type { BatchManifest, PublishedBatchManifest } from "./types.js";

export function publishedManifest(
  manifest: BatchManifest,
  generation: string,
): PublishedBatchManifest {
  return { ...manifest, generation, tileBase: `generations/${generation}/` };
}

export async function assertPublicationTarget(output: string): Promise<void> {
  const path = ownedPath(output, "manifest.json");
  try {
    await assertNoLinks(path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 128 * 1024 ** 2)
      throw new Error("Invalid existing publication manifest");
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Reflect.get(value, "format") !== "mapelix-2d" ||
      Reflect.get(value, "schemaVersion") !== 1 ||
      Reflect.get(value, "complete") !== true ||
      typeof Reflect.get(value, "generation") !== "string" ||
      !/^[a-f0-9]{64}$/.test(Reflect.get(value, "generation") as string) ||
      Reflect.get(value, "tileBase") !== `generations/${String(Reflect.get(value, "generation"))}/`
    ) {
      throw new Error("Refusing to replace an unrelated or unsupported manifest.json");
    }
  } catch (cause) {
    if (!isMissing(cause)) throw cause;
  }
}

/** Verify all bytes and reject extra files before accepting a completed payload. */
export async function verifyGeneration(
  directory: string,
  manifest: BatchManifest,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const expectedFiles = [
    "manifest.json",
    ...(manifest.sourceChunks === undefined ? [] : [manifest.sourceChunks.path]),
    ...manifest.tiles.map((tile) => tile.path),
  ].sort();
  const files = await assertTreeNoLinks(directory);
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    throw new Error("Generation file inventory mismatch");
  const expected = jsonBytes(manifest);
  const stored = await identifyFile(
    ownedPath(directory, "manifest.json"),
    "manifest.json",
    Buffer.byteLength(expected),
    signal,
  );
  if (stored.bytes !== Buffer.byteLength(expected) || stored.sha256 !== sha256(expected))
    throw new Error("Generation manifest mismatch");
  for (const tile of [
    ...(manifest.sourceChunks === undefined ? [] : [manifest.sourceChunks]),
    ...manifest.tiles,
  ]) {
    signal.throwIfAborted();
    const actual = await identifyFile(
      ownedPath(directory, tile.path),
      tile.path,
      tile.bytes,
      signal,
    );
    if (actual.bytes !== tile.bytes || actual.sha256 !== tile.sha256)
      throw new Error(`Tile digest mismatch: ${tile.path}`);
  }
}

export function generationId(manifest: BatchManifest): string {
  return sha256(jsonBytes(manifest));
}
