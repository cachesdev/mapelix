import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { Client, percentile, rounded, output, fingerprint } from "./bench.mjs";
import { key } from "./prototype.mjs";

class Pool {
  constructor(permits) {
    this.clients = Array.from({ length: permits }, () => ({
      client: new Client(),
      busy: false,
    }));
    this.queue = [];
    this.peakQueue = 0;
  }
  build(request, priority = 0) {
    return new Promise((resolve, reject) => {
      this.queue.push({ request: { ...request }, priority, resolve, reject });
      this.queue.sort((a, b) => a.priority - b.priority);
      this.peakQueue = Math.max(this.peakQueue, this.queue.length);
      this.pump();
    });
  }
  pump() {
    for (const slot of this.clients) {
      if (slot.busy) continue;
      const item = this.queue.shift();
      if (!item) break;
      slot.busy = true;
      slot.client
        .build(item.request, true)
        .then(item.resolve, item.reject)
        .finally(() => {
          slot.busy = false;
          this.pump();
        });
    }
  }
  close() {
    return Promise.all(this.clients.map((s) => s.client.close()));
  }
}
class Shared {
  constructor(pool) {
    this.pool = pool;
    this.memory = new Map();
    this.flight = new Map();
    this.stats = { hits: 0, coalesced: 0, builds: 0, bytes: 0 };
  }
  get(q, priority = 0) {
    const id = key(q.dimension ?? "overworld", q);
    if (this.memory.has(id)) {
      this.stats.hits++;
      return Promise.resolve(this.memory.get(id));
    }
    if (this.flight.has(id)) {
      this.stats.coalesced++;
      return this.flight.get(id);
    }
    const p = this.pool
      .build(q, priority)
      .then((r) => {
        this.stats.builds++;
        this.stats.bytes += r.byteLength;
        this.memory.set(id, r);
        return r;
      })
      .finally(() => this.flight.delete(id));
    this.flight.set(id, p);
    return p;
  }
}
const results = [];
for (const permits of [1, 2])
  for (const visitors of permits === 1 ? [1, 5, 20] : [20])
    for (const withPrewarm of [false, true]) {
      global.gc?.();
      const pool = new Pool(permits),
        shared = new Shared(pool),
        latencies = [],
        cpu = process.cpuUsage(),
        start = performance.now();
      let peak = process.memoryUsage().rss;
      const sample = setInterval(
        () => (peak = Math.max(peak, process.memoryUsage().rss)),
        5,
      );
      try {
        const prewarm = withPrewarm
          ? (async () => {
              for (const level of [5, 3, 1, 0])
                await shared.get(
                  {
                    dimension: "overworld",
                    mode: "default",
                    level,
                    x: -1,
                    z: 0,
                  },
                  1,
                );
            })()
          : Promise.resolve();
        if (withPrewarm) await new Promise((r) => setTimeout(r, 10));
        const requests = [];
        for (let user = 0; user < visitors; user++)
          for (let region = 0; region < 4; region++) {
            const t = performance.now(),
              q = {
                dimension: "overworld",
                mode: "caves",
                minY: [-64, -32, 0, 32][user % 4],
                maxY: [-32, 0, 32, 64][user % 4],
                level: 0,
                x: -2 + (region % 2),
                z: Math.floor(region / 2),
              };
            requests.push(q);
            requests[requests.length - 1].promise = shared
              .get(q)
              .then(() => latencies.push(performance.now() - t));
          }
        await Promise.all(requests.map((q) => q.promise));
        const foregroundWall = performance.now() - start;
        await prewarm;
        const coldStats = { ...shared.stats },
          warmStart = performance.now();
        await Promise.all(requests.map((q) => shared.get(q)));
        const warmWall = performance.now() - warmStart;
        const used = process.cpuUsage(cpu),
          row = {
            permits,
            visitors,
            requests: requests.length,
            withPrewarm,
            foregroundWallMs: rounded(foregroundWall),
            allWallMs: rounded(performance.now() - start),
            latencyMedianMs: rounded(percentile(latencies, 0.5)),
            latencyP95Ms: rounded(percentile(latencies, 0.95)),
            cpuMs: rounded((used.user + used.system) / 1000),
            peakRssMiB: rounded(peak / 1048576),
            peakQueue: pool.peakQueue,
            coldStats,
            warmStats: { ...shared.stats },
            warmBatchMs: rounded(warmWall),
          };
        results.push(row);
        console.log(JSON.stringify(row));
        writeFileSync(
          join(output, "concurrency.json"),
          JSON.stringify(
            {
              method:
                "Independent M0 harness, shared priority queue and in-flight deduplication; no scene-server code modified; foreground jobs outrank queued prewarm jobs; active prewarm jobs are not interrupted",
              rows: results,
            },
            null,
            2,
          ),
        );
      } finally {
        clearInterval(sample);
        await pool.close();
      }
    }

// A local cache-growth experiment, not an implementation of the integration server.
class Partition {
  constructor(name, diskLimit, memoryLimit, revision) {
    this.name = name;
    this.diskLimit = diskLimit;
    this.memoryLimit = memoryLimit;
    this.path = join(output, "cache-simulation", revision, name);
    mkdirSync(this.path, { recursive: true });
    this.disk = new Map();
    this.memory = new Map();
    this.diskBytes = 0;
    this.memoryBytes = 0;
    this.evicted = 0;
    this.peakDisk = 0;
    this.peakMemory = 0;
    this.hits = 0;
    this.misses = 0;
  }
  get(id) {
    let e = this.disk.get(id);
    if (!e) {
      this.misses++;
      return;
    }
    this.hits++;
    this.disk.delete(id);
    this.disk.set(id, e);
    const bytes = readFileSync(e.path);
    this.remember(id, bytes);
    return bytes;
  }
  put(id, bytes) {
    if (bytes.length > this.diskLimit) return;
    const path = join(this.path, id.replaceAll("/", "_") + ".bin");
    writeFileSync(path, bytes);
    const old = this.disk.get(id);
    if (old) this.diskBytes -= old.length;
    this.disk.delete(id);
    this.disk.set(id, { path, length: bytes.length });
    this.diskBytes += bytes.length;
    this.remember(id, bytes);
    while (this.diskBytes > this.diskLimit) {
      const [victim, e] = this.disk.entries().next().value;
      this.disk.delete(victim);
      this.diskBytes -= e.length;
      unlinkSync(e.path);
      this.evicted++;
    }
    this.peakDisk = Math.max(this.peakDisk, this.diskBytes);
  }
  remember(id, bytes) {
    const old = this.memory.get(id);
    if (old) this.memoryBytes -= old.length;
    this.memory.delete(id);
    this.memory.set(id, bytes);
    this.memoryBytes += bytes.length;
    while (this.memoryBytes > this.memoryLimit) {
      const [victim, e] = this.memory.entries().next().value;
      this.memory.delete(victim);
      this.memoryBytes -= e.length;
    }
    this.peakMemory = Math.max(this.peakMemory, this.memoryBytes);
  }
  stats() {
    return {
      entries: this.disk.size,
      diskBytes: this.diskBytes,
      memoryBytes: this.memoryBytes,
      evicted: this.evicted,
      hits: this.hits,
      misses: this.misses,
      peakDisk: this.peakDisk,
      peakMemory: this.peakMemory,
    };
  }
  clearFiles() {
    for (const e of this.disk.values()) unlinkSync(e.path);
    this.disk.clear();
    this.memory.clear();
    this.diskBytes = this.memoryBytes = 0;
  }
}
global.gc?.();
const cacheClient = new Client(),
  MiB = 1048576,
  protectedSurface = new Partition("surface", 8 * MiB, 2 * MiB, "revision-a"),
  caves = new Partition("caves", 8 * MiB, 2 * MiB, "revision-a");
const cacheRows = [];
let peak = process.memoryUsage().rss;
const timer = setInterval(
    () => (peak = Math.max(peak, process.memoryUsage().rss)),
    5,
  ),
  cacheStart = performance.now(),
  cacheCpu = process.cpuUsage();
try {
  const surfaceRequest = {
      dimension: "overworld",
      mode: "default",
      level: 0,
      x: -1,
      z: 0,
    },
    surfaceBytes = (await cacheClient.build(surfaceRequest, true)).bytes,
    surfaceKey = key("overworld", surfaceRequest);
  protectedSurface.put(surfaceKey, surfaceBytes);
  const explored = [];
  for (const level of [0, 1])
    for (const minY of [-64, -48, -32, -16, 0, 16, 32])
      for (const thickness of [16, 32, 64])
        for (const [x, z] of [
          [-2, 0],
          [-1, 0],
          [0, 0],
          [-1, 1],
        ]) {
          const q = {
              dimension: "overworld",
              mode: "caves",
              minY,
              maxY: minY + thickness,
              level,
              x,
              z,
            },
            id = key("overworld", q);
          explored.push(q);
          const bytes = (await cacheClient.build(q, true)).bytes;
          caves.put(id, bytes);
          if (explored.length % 12 === 0) {
            const row = {
              generated: explored.length,
              elapsedMs: rounded(performance.now() - cacheStart),
              surface: protectedSurface.stats(),
              caves: caves.stats(),
              peakRssMiB: rounded(peak / 1048576),
            };
            cacheRows.push(row);
            writeFileSync(
              join(output, "cache-growth.json"),
              JSON.stringify(
                {
                  method:
                    "Local actual region files, deliberately small 8 MiB disk / 2 MiB encoded-memory caps per partition to force eviction",
                  rows: cacheRows,
                },
                null,
                2,
              ),
            );
            console.log(JSON.stringify({ cacheGrowth: row }));
          }
        }
  let rebuilds = 0;
  for (const q of [...explored.slice(0, 12), ...explored.slice(-12)]) {
    const id = key("overworld", q);
    if (!caves.get(id)) {
      rebuilds++;
      caves.put(id, (await cacheClient.build(q, true)).bytes);
    }
  }
  const surfaceSurvived = Buffer.from(protectedSurface.get(surfaceKey)).equals(
    Buffer.from(surfaceBytes),
  );
  const beforeCleanup =
    protectedSurface.stats().diskBytes + caves.stats().diskBytes;
  // Known files in the experiment's own cache only; no recursive delete and no external paths.
  caves.clearFiles();
  protectedSurface.clearFiles();
  const remaining =
    readdirSync(join(output, "cache-simulation", "revision-a", "caves"))
      .length +
    readdirSync(join(output, "cache-simulation", "revision-a", "surface"))
      .length;
  const used = process.cpuUsage(cacheCpu);
  const result = {
    rows: cacheRows,
    generated: explored.length,
    revisitRequests: 24,
    rebuilds,
    surfaceSurvived,
    obsoleteRevision: { bytesBefore: beforeCleanup, filesAfter: remaining },
    peakRssMiB: rounded(peak / 1048576),
    cpuMs: rounded((used.user + used.system) / 1000),
    wallMs: rounded(performance.now() - cacheStart),
  };
  writeFileSync(
    join(output, "cache-growth.json"),
    JSON.stringify(result, null, 2),
  );
} finally {
  clearInterval(timer);
  await cacheClient.close();
}
const before = JSON.parse(
    readFileSync(join(output, "snapshot-before.json"), "utf8"),
  ),
  after = fingerprint();
if (JSON.stringify(before) !== JSON.stringify(after))
  throw new Error("Snapshot changed");
