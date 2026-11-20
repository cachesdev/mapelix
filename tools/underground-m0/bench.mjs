import { Worker } from "node:worker_threads";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import os from "node:os";
import { WorldDatabase } from "../../packages/mapelix-scene-prototype/dist/leveldb/world-database.js";
import {
  decodeSceneRegion,
  regionSpan,
} from "../../packages/mapelix-scene-prototype/dist/format.js";
const base = resolve(import.meta.dirname, "../../.local/underground-m0");
export const directory = process.env.MAPELIX_M0_WORLD_DIRECTORY;
if (!directory)
  throw new Error(
    "Set MAPELIX_M0_WORLD_DIRECTORY to a disposable extracted world snapshot",
  );
export const output = join(base, "results");
mkdirSync(output, { recursive: true });
export function fingerprint() {
  return Object.fromEntries(
    ["level.dat", ...readdirSync(join(directory, "db")).map((n) => "db/" + n)]
      .filter((n) => statSync(join(directory, n)).isFile())
      .map((n) => [
        n,
        createHash("sha256")
          .update(readFileSync(join(directory, n)))
          .digest("hex"),
      ]),
  );
}
export class Client {
  constructor(world = directory) {
    this.worker = new Worker(new URL("./worker.mjs", import.meta.url), {
      workerData: { directory: world },
    });
    this.pending = new Map();
    this.id = 0;
    this.worker.on("message", (m) => {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m);
    });
    this.worker.on("error", (e) => {
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    });
  }
  build(request, keepBytes = false) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, request, keepBytes });
    });
  }
  close() {
    return this.worker.terminate();
  }
}
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}
export function rounded(value) {
  return Math.round(value * 100) / 100;
}
function inventory() {
  const db = WorldDatabase.open(directory),
    chunks = new Map();
  try {
    for (const r of db.readPrefix(new Uint8Array())) {
      const k = r.key,
        off = k.length === 10 ? 8 : k.length === 14 ? 12 : -1;
      if (off < 0 || k[off] !== 0x2f) continue;
      const v = new DataView(k.buffer, k.byteOffset, k.byteLength),
        dim = off === 8 ? 0 : v.getInt32(8, true);
      if (dim < 0 || dim > 2) continue;
      let found = chunks.get(dim);
      if (!found) chunks.set(dim, (found = new Map()));
      found.set(`${v.getInt32(0, true)},${v.getInt32(4, true)}`, {
        x: v.getInt32(0, true),
        z: v.getInt32(4, true),
      });
    }
  } finally {
    db.close();
  }
  const dimensions = [];
  for (const [id, positions] of chunks) {
    const a = [...positions.values()],
      bounds = {
        minX: Math.min(...a.map((c) => c.x)) * 16,
        minZ: Math.min(...a.map((c) => c.z)) * 16,
        maxX: Math.max(...a.map((c) => c.x)) * 16 + 15,
        maxZ: Math.max(...a.map((c) => c.z)) * 16 + 15,
      };
    const levels = Array.from({ length: 6 }, (_, level) => {
      const span = regionSpan(level),
        occupied = new Set(
          a.map(
            (c) =>
              `${Math.floor((c.x * 16) / span)},${Math.floor((c.z * 16) / span)}`,
          ),
        );
      return {
        level,
        occupied: occupied.size,
        boundingRectangle:
          (Math.floor(bounds.maxX / span) -
            Math.floor(bounds.minX / span) +
            1) *
          (Math.floor(bounds.maxZ / span) - Math.floor(bounds.minZ / span) + 1),
      };
    });
    const segments = id === 0 ? 24 : id === 1 ? 8 : 16;
    const windows163264 = segments + (segments - 1) + (segments - 3);
    const windowsUpTo64 =
      segments + (segments - 1) + (segments - 2) + (segments - 3);
    dimensions.push({
      dimension: ["overworld", "nether", "the-end"][id],
      chunks: a.length,
      bounds,
      levels,
      windows163264,
      windowsUpTo64,
      variantsNearL0L1: {
        occupied:
          levels.slice(0, 2).reduce((s, l) => s + l.occupied, 0) *
          windows163264,
        boundingRectangle:
          levels.slice(0, 2).reduce((s, l) => s + l.boundingRectangle, 0) *
          windows163264,
      },
    });
  }
  return dimensions;
}
if (
  process.argv[1] ===
    new URL(import.meta.url).pathname
      .replace(/^\/(\w:)/, "$1")
      .replaceAll("/", "\\") ||
  process.argv.includes("--run")
) {
  const initial = fingerprint();
  writeFileSync(
    join(output, "snapshot-before.json"),
    JSON.stringify(initial, null, 2),
  );
  const dimensions = inventory();
  writeFileSync(
    join(output, "inventory.json"),
    JSON.stringify(dimensions, null, 2),
  );
  console.log(
    JSON.stringify({
      inventory: dimensions.map((d) => ({
        dimension: d.dimension,
        chunks: d.chunks,
        bounds: d.bounds,
        variants: d.variantsNearL0L1,
      })),
    }),
  );
  const cases = [];
  for (const minY of [-64, -32, 0, 32])
    for (const thickness of [8, 16, 32, 64])
      for (const level of [0, 1, 2])
        cases.push({
          dimension: "overworld",
          mode: "caves",
          minY,
          maxY: minY + thickness,
          level,
          x: -1,
          z: 0,
        });
  for (const thickness of [16, 32, 64])
    for (const level of [0, 1, 2])
      cases.push({
        dimension: "nether",
        mode: "caves",
        minY: 0,
        maxY: thickness,
        level,
        x: 0,
        z: 0,
      });
  for (const dimension of ["overworld", "nether"])
    for (const level of [0, 1, 2, 3, 5])
      cases.push({
        dimension,
        mode: "default",
        level,
        x: dimension === "overworld" ? -1 : 0,
        z: 0,
      });
  const rows = [];
  for (const request of cases) {
    global.gc?.();
    const client = new Client();
    let peak = process.memoryUsage().rss;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    const cpu = process.cpuUsage(),
      start = performance.now();
    try {
      const cold = await client.build(request, true),
        r = decodeSceneRegion(cold.bytes);
      const times = [];
      let timing;
      for (let run = 0; run < 10; run++) {
        const result = await client.build(request);
        if (run >= 2) times.push(result.milliseconds);
        timing = result.timings;
      }
      const used = process.cpuUsage(cpu);
      const row = {
        ...request,
        coldBuildMs: rounded(cold.milliseconds),
        warmMedianMs: rounded(percentile(times, 0.5)),
        warmP95Ms: rounded(percentile(times, 0.95)),
        payloadBytes: cold.byteLength,
        quads: (r.opaque.length + r.plants.length + r.translucent.length) / 3,
        peakRssMiB: rounded(peak / 1048576),
        cpuMs: rounded((used.user + used.system) / 1000),
        wallMs: rounded(performance.now() - start),
        lastPhases: timing,
      };
      rows.push(row);
      writeFileSync(
        join(output, "matrix.json"),
        JSON.stringify(
          {
            base: "e02cf7c",
            node: process.version,
            cpu: os.cpus()[0].model,
            logicalCpus: os.availableParallelism(),
            method:
              "one worker per case; cold first build; ten additional builds, discard two, median/p95 of eight; app caches only, OS cache not purged",
            rows,
          },
          null,
          2,
        ),
      );
      console.log(JSON.stringify(row));
    } finally {
      clearInterval(sample);
      await client.close();
    }
  }
  const after = fingerprint();
  if (JSON.stringify(initial) !== JSON.stringify(after))
    throw new Error("Snapshot changed");
  writeFileSync(
    join(output, "snapshot-after.json"),
    JSON.stringify(after, null, 2),
  );
}
