import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  SurfaceStoreReader,
  SurfaceStoreWriter,
  decodeChunkSurface,
  encodeChunkSurface,
  encodeSurfacePack,
  parseSurfacePack,
  surfaceStoreDigest,
  type SurfaceStoreJob,
} from "./chunk-surface-store.js";
import type { SurfaceBlockStyle } from "./surface-style.js";
import type { SurfaceBlock } from "./tile.js";
import type { ChunkSurface } from "./world.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const grass: SurfaceBlockStyle = {
  color: { red: 90, green: 140, blue: 60, alpha: 255 },
  biomeTint: "grass",
};
const water: SurfaceBlockStyle = {
  color: { red: 40, green: 60, blue: 200, alpha: 160 },
  biomeTint: "water",
};

function surface(seed: number, biomes = true): ChunkSurface {
  return Array.from({ length: 256 }, (_, index): SurfaceBlock | undefined => {
    if ((index + seed) % 17 === 0) return undefined;
    const block: SurfaceBlock = {
      name: index % 5 === 0 ? "minecraft:water" : "minecraft:grass_block",
      style: index % 5 === 0 ? water : grass,
      y: 60 + ((index + seed) % 9),
      shadowRuns: [
        { minY: 50, maxY: 60 + (index % 3), opacity: 1 },
        { minY: -64, maxY: 10, opacity: 0.6 },
      ],
      ...(index % 5 === 0
        ? { fluidDepth: 3, underwaterName: "minecraft:sand", underwaterStyle: grass }
        : {}),
      ...(index % 31 === 0
        ? { colorLayers: [{ name: "minecraft:glass", style: water, count: 2 }], supportY: 58 }
        : {}),
    };
    return biomes ? { ...block, biomeId: index % 4 } : block;
  });
}

async function storeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mapelix-surface-store-"));
  roots.push(root);
  return root;
}

function job(
  writer: SurfaceStoreWriter,
  fingerprints: Record<string, string>,
  dimension = 0,
): SurfaceStoreJob {
  const config = surfaceStoreDigest(`config-${dimension}`);
  return {
    directory: writer.configDirectory(config),
    config,
    dimension,
    fingerprints: new Map(Object.entries(fingerprints)),
  };
}

describe("chunk surface encoding", () => {
  it("round-trips surfaces exactly", () => {
    const value = surface(3);
    expect(decodeChunkSurface(encodeChunkSurface(value)!)).toEqual(value);
  });

  it("refuses values it cannot reproduce exactly", () => {
    const value = [...surface(1)];
    value[4] = { name: "minecraft:stone", y: 3, biomeId: undefined } as unknown as SurfaceBlock;
    expect(encodeChunkSurface(value)).toBeUndefined();
    value[4] = { name: "minecraft:stone", y: -0 };
    expect(encodeChunkSurface(value)).toBeUndefined();
    value[4] = { name: "minecraft:stone", y: 3, unknown: 1 } as SurfaceBlock;
    expect(encodeChunkSurface(value)).toBeUndefined();
    expect(encodeChunkSurface(value.slice(0, 255))).toBeUndefined();
  });

  it("rejects damaged surface blobs and packs", () => {
    const blob = encodeChunkSurface(surface(2))!;
    expect(decodeChunkSurface(blob.subarray(0, blob.byteLength - 3))).toBeUndefined();
    expect(decodeChunkSurface(new Uint8Array([1, 2, 3]))).toBeUndefined();
    const config = surfaceStoreDigest("config");
    const pack = encodeSurfacePack(0, config, [
      { x: 1, z: 2, scoped: true, fingerprint: "f1", blob },
    ]);
    expect(parseSurfacePack(pack, { dimension: 0, config })?.entries.size).toBe(1);
    expect(parseSurfacePack(pack, { dimension: 1, config })).toBeUndefined();
    expect(
      parseSurfacePack(pack, { dimension: 0, config: surfaceStoreDigest("x") }),
    ).toBeUndefined();
    for (const offset of [0, 20, 60, pack.byteLength - 40, pack.byteLength - 1]) {
      const damaged = pack.slice();
      damaged[offset]! ^= 0x41;
      expect(parseSurfacePack(damaged)).toBeUndefined();
    }
    expect(parseSurfacePack(pack.subarray(0, pack.byteLength - 1))).toBeUndefined();
  });
});

describe("surface store", () => {
  it("serves only entries whose chunk fingerprint is unchanged", async () => {
    const root = await storeRoot();
    const writer = new SurfaceStoreWriter({ root, namespace: "a", maxBytes: 1 << 24 });
    const before = job(writer, { "0,0": "f0", "1,0": "f1", "40,0": "f2" });
    const reader = new SurfaceStoreReader();
    reader.record(before, 0, 0, true, surface(0));
    reader.record(before, 1, 0, false, surface(1, false));
    reader.record(before, 40, 0, true, surface(2));
    reader.record(before, 9, 9, true, surface(3)); // no fingerprint: never stored
    writer.add(reader.drain());
    await writer.flush(() => before.fingerprints);
    expect(writer.stats.writtenBytes).toBeGreaterThan(0);

    const after = job(writer, { "0,0": "f0", "1,0": "changed", "40,0": "f2" });
    const next = new SurfaceStoreReader();
    expect(await next.lookup(after, 0, 0, true)).toEqual(surface(0));
    // A biome-free lookup is served from the biome-scoped entry.
    expect(await next.lookup(after, 0, 0, false)).toEqual(surface(0, false));
    expect(await next.lookup(after, 1, 0, false)).toBeUndefined();
    expect(await next.lookup(after, 40, 0, false)).toEqual(surface(2, false));
    expect(await next.lookup(after, 9, 9, true)).toBeUndefined();
    expect(next.stats.hits).toBe(3);

    // Flushing with the new fingerprints drops the stale entry; a different namespace is removed.
    const cleaner = new SurfaceStoreWriter({ root, namespace: "a", maxBytes: 1 << 24 });
    await cleaner.flush(() => after.fingerprints);
    const pack = await readFile(join(after.directory, "0_0.pack"));
    expect([...parseSurfacePack(pack)!.entries.keys()]).toEqual(["0,0,1"]);
    const other = new SurfaceStoreWriter({ root, namespace: "b", maxBytes: 1 << 24 });
    await other.flush(() => after.fingerprints);
    expect(await readdir(root)).toEqual([surfaceStoreDigest("b").slice(0, 32)]);
  });

  it("ignores damaged packs and replaces them", async () => {
    const root = await storeRoot();
    const writer = new SurfaceStoreWriter({ root, namespace: "a", maxBytes: 1 << 24 });
    const view = job(writer, { "0,0": "f0" });
    const reader = new SurfaceStoreReader();
    reader.record(view, 0, 0, true, surface(0));
    writer.add(reader.drain());
    await writer.flush(() => view.fingerprints);
    const path = join(view.directory, "0_0.pack");
    const bytes = await readFile(path);
    bytes[bytes.byteLength - 50]! ^= 1;
    await writeFile(path, bytes);
    await writeFile(join(view.directory, "junk.tmp"), "junk");
    const damaged = new SurfaceStoreReader();
    expect(await damaged.lookup(view, 0, 0, true)).toBeUndefined();
    expect(damaged.stats.rejected).toBe(1);
    damaged.record(view, 0, 0, true, surface(0));
    writer.add(damaged.drain());
    await writer.flush(() => view.fingerprints);
    expect(await readdir(view.directory)).toEqual(["0_0.pack"]);
    expect(await new SurfaceStoreReader().lookup(view, 0, 0, true)).toEqual(surface(0));
  });

  it("keeps the store within its size bound", async () => {
    const root = await storeRoot();
    const fingerprints = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`${index * 16},0`, `f${index}`]),
    );
    const writer = new SurfaceStoreWriter({ root, namespace: "a", maxBytes: 12_000 });
    const view = job(writer, fingerprints);
    const reader = new SurfaceStoreReader();
    for (let index = 0; index < 8; index += 1)
      reader.record(view, index * 16, 0, true, surface(index));
    writer.add(reader.drain());
    const stats = await writer.flush(() => view.fingerprints);
    expect(stats.totalBytes).toBeLessThanOrEqual(12_000);
    let total = 0;
    for (const name of await readdir(view.directory))
      total += (await stat(join(view.directory, name))).size;
    expect(total).toBe(stats.totalBytes);
  });

  it("refuses links inside the store", async () => {
    const root = await storeRoot();
    const outside = await storeRoot();
    await mkdir(join(outside, "target"));
    await symlink(join(outside, "target"), join(root, "linked"), "junction");
    const writer = new SurfaceStoreWriter({ root, namespace: "a", maxBytes: 1 << 20 });
    await expect(writer.flush(() => undefined)).rejects.toThrow(/links/);
    expect(await readdir(join(outside, "target"))).toEqual([]);
  });
});
