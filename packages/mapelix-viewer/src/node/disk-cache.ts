import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { REVISION_PATTERN } from "./revision.js";

export interface DiskCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
}

export interface DiskCacheEvents {
  readonly onEvent?: (event: string, detail: Record<string, unknown>) => void;
}

const ENTRY_NAME = /^-?\d{1,9}\.bin$/;

/**
 * Region files for one world revision under `<root>/<revision>/`. The cache keeps
 * its own byte budget: the oldest files go first once a write passes it. Other
 * revision folders are removed when the cache opens, so a new snapshot never
 * leaves the previous one's regions behind. Only names this cache creates are
 * ever deleted.
 */
export class DiskCache {
  private readonly directory: string;
  private readonly maxBytes: number;
  private readonly events: DiskCacheEvents;
  /** Relative path to size, oldest first. */
  private readonly entries = new Map<string, number>();
  private bytes = 0;

  private constructor(directory: string, maxBytes: number, events: DiskCacheEvents) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.events = events;
  }

  static async open(
    root: string,
    revision: string,
    maxBytes: number,
    events: DiskCacheEvents = {},
  ): Promise<DiskCache> {
    if (!REVISION_PATTERN.test(revision)) throw new Error(`Invalid cache revision ${revision}`);
    await mkdir(root, { recursive: true, mode: 0o750 });
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && REVISION_PATTERN.test(entry.name) && entry.name !== revision) {
        await rm(join(root, entry.name), { recursive: true, force: true });
        events.onEvent?.("cache.revision-removed", { revision: entry.name });
      }
    }
    const directory = join(root, revision);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const cache = new DiskCache(directory, maxBytes, events);
    await cache.index();
    await cache.evict();
    return cache;
  }

  get stats(): DiskCacheStats {
    return { entries: this.entries.size, bytes: this.bytes, maxBytes: this.maxBytes };
  }

  /** Returns the stored bytes, or undefined on a miss or an unreadable file. */
  async read(key: string): Promise<Uint8Array | undefined> {
    const path = this.path(key);
    const size = this.entries.get(path.relative);
    if (size === undefined) return undefined;
    try {
      const bytes = await readFile(path.absolute);
      // Most recently used moves to the back of the eviction order.
      this.entries.delete(path.relative);
      this.entries.set(path.relative, size);
      return bytes;
    } catch {
      await this.forget(path.relative);
      return undefined;
    }
  }

  /** Writes atomically. A failed write leaves the cache unchanged and is only reported. */
  async write(key: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength > this.maxBytes) return;
    const path = this.path(key);
    const temporary = `${path.absolute}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(path.absolute), { recursive: true, mode: 0o750 });
      await writeFile(temporary, bytes, { mode: 0o640 });
      await rename(temporary, path.absolute);
    } catch (cause) {
      await unlink(temporary).catch(() => undefined);
      this.events.onEvent?.("cache.write-failed", { key, message: errorMessage(cause) });
      return;
    }
    const previous = this.entries.get(path.relative);
    if (previous !== undefined) {
      this.bytes -= previous;
      this.entries.delete(path.relative);
    }
    this.entries.set(path.relative, bytes.byteLength);
    this.bytes += bytes.byteLength;
    await this.evict();
  }

  /** Drops an entry whose bytes turned out to be unusable. */
  async discard(key: string): Promise<void> {
    await this.forget(this.path(key).relative);
  }

  private async forget(relativePath: string): Promise<void> {
    const size = this.entries.get(relativePath);
    if (size !== undefined) {
      this.entries.delete(relativePath);
      this.bytes -= size;
    }
    await unlink(join(this.directory, relativePath)).catch(() => undefined);
  }

  /** Keys look like `overworld/3/-2/7`; only the last part becomes a file name. */
  private path(key: string): { absolute: string; relative: string } {
    const parts = key.split("/");
    const file = `${parts.pop()}.bin`;
    if (!ENTRY_NAME.test(file) || parts.some((part) => !/^[a-z-]+$|^-?\d{1,9}$/.test(part))) {
      throw new Error(`Invalid cache key ${key}`);
    }
    const relativePath = [...parts, file].join(sep);
    return { absolute: join(this.directory, relativePath), relative: relativePath };
  }

  private async index(): Promise<void> {
    const found: { relative: string; size: number; time: number }[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (entry.isFile() && entry.name.endsWith(".tmp")) {
          // A write interrupted by a crash or a stop.
          await unlink(path).catch(() => undefined);
        } else if (entry.isFile() && ENTRY_NAME.test(entry.name)) {
          const details = await stat(path);
          found.push({
            relative: relative(this.directory, path),
            size: details.size,
            time: details.mtimeMs,
          });
        }
      }
    };
    await walk(this.directory);
    found.sort((left, right) => left.time - right.time);
    for (const file of found) {
      this.entries.set(file.relative, file.size);
      this.bytes += file.size;
    }
  }

  private async evict(): Promise<void> {
    if (this.bytes <= this.maxBytes) return;
    const target = this.maxBytes * 0.9;
    let removed = 0;
    for (const [relativePath, size] of this.entries) {
      if (this.bytes <= target) break;
      this.entries.delete(relativePath);
      this.bytes -= size;
      removed += 1;
      await unlink(join(this.directory, relativePath)).catch(() => undefined);
    }
    this.events.onEvent?.("cache.evicted", { files: removed, bytes: this.bytes });
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
