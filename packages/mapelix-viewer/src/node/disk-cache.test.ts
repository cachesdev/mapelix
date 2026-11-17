import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiskCache } from "./disk-cache.js";

const REVISION = "0123456789abcdef0123";
const OLD_REVISION = "fedcba9876543210fedc";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-cache-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("DiskCache", () => {
  it("removes other revisions and interrupted writes, but leaves unknown names", async () => {
    await mkdir(join(root, OLD_REVISION, "overworld", "0", "1"), { recursive: true });
    await writeFile(join(root, OLD_REVISION, "overworld", "0", "1", "2.bin"), "old");
    await mkdir(join(root, REVISION, "overworld", "0", "1"), { recursive: true });
    await writeFile(join(root, REVISION, "overworld", "0", "1", "3.bin.abc.tmp"), "partial");
    await mkdir(join(root, "keep-me"));
    const events: string[] = [];
    await DiskCache.open(root, REVISION, 1024 * 1024, { onEvent: (event) => events.push(event) });
    expect((await readdir(root)).sort()).toEqual([REVISION, "keep-me"].sort());
    expect(await readdir(join(root, REVISION, "overworld", "0", "1"))).toEqual([]);
    expect(events).toContain("cache.revision-removed");
  });

  it("writes, reads, and survives a reopen", async () => {
    const cache = await DiskCache.open(root, REVISION, 1024 * 1024);
    await cache.write("overworld/2/-3/4", new Uint8Array([1, 2, 3]));
    expect(Array.from((await cache.read("overworld/2/-3/4")) ?? [])).toEqual([1, 2, 3]);
    expect(await cache.read("overworld/2/-3/5")).toBeUndefined();
    const reopened = await DiskCache.open(root, REVISION, 1024 * 1024);
    expect(reopened.stats).toMatchObject({ entries: 1, bytes: 3 });
    expect(Array.from((await reopened.read("overworld/2/-3/4")) ?? [])).toEqual([1, 2, 3]);
  });

  it("evicts the oldest files beyond its budget", async () => {
    const cache = await DiskCache.open(root, REVISION, 1000);
    for (let x = 0; x < 5; x += 1) await cache.write(`overworld/0/${x}/0`, new Uint8Array(300));
    expect(cache.stats.bytes).toBeLessThanOrEqual(1000);
    expect(await cache.read("overworld/0/0/0")).toBeUndefined();
    expect(await cache.read("overworld/0/4/0")).toBeDefined();
  });

  it("orders existing files by age when it opens over budget", async () => {
    const first = await DiskCache.open(root, REVISION, 10_000);
    await first.write("overworld/0/0/0", new Uint8Array(400));
    await first.write("overworld/0/1/0", new Uint8Array(400));
    const older = join(root, REVISION, "overworld", "0", "1", "0.bin");
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    const reopened = await DiskCache.open(root, REVISION, 500);
    expect(reopened.stats.entries).toBe(1);
    expect(await reopened.read("overworld/0/0/0")).toBeDefined();
  });

  it("rejects keys that could leave its folder", async () => {
    const cache = await DiskCache.open(root, REVISION, 1000);
    for (const key of ["../0/0/0", "overworld/../../x/0", "overworld/0/0/a", "Over/0/0/0"]) {
      await expect(cache.write(key, new Uint8Array(1))).rejects.toThrow(/Invalid cache key/);
    }
    await expect(DiskCache.open(root, "../x", 1000)).rejects.toThrow(/Invalid cache revision/);
  });

  it("forgets a discarded entry", async () => {
    const cache = await DiskCache.open(root, REVISION, 1000);
    await cache.write("nether/1/0/0", new Uint8Array(10));
    await cache.discard("nether/1/0/0");
    expect(cache.stats).toMatchObject({ entries: 0, bytes: 0 });
    expect(await cache.read("nether/1/0/0")).toBeUndefined();
  });
});
