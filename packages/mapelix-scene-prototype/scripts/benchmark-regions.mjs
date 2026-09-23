// Builds a square of regions around a block position and reports build time and quad counts.
import { openSceneWorld } from "../dist/index.js";
import { decodeSceneRegion, regionSpan } from "../dist/format.js";

const directory = process.env.MAPELIX_WORLD_DIRECTORY;
if (directory === undefined) throw new Error("Set MAPELIX_WORLD_DIRECTORY to a Bedrock world");
const level = Number(process.env.MAPELIX_BENCH_LEVEL ?? 0);
const radius = Number(process.env.MAPELIX_BENCH_RADIUS ?? 1);
const workers = Number(process.env.MAPELIX_BENCH_WORKERS ?? 4);

const openedAt = performance.now();
const world = await openSceneWorld({ directory, workers });
const center = {
  x: Number(process.env.MAPELIX_BENCH_X ?? world.info.spawn.x),
  z: Number(process.env.MAPELIX_BENCH_Z ?? world.info.spawn.z),
};
console.log(
  `${world.info.name}: spawn ${JSON.stringify(world.info.spawn)}, opened in ${(performance.now() - openedAt).toFixed(0)} ms`,
);

const span = regionSpan(level);
const centerX = Math.floor(center.x / span);
const centerZ = Math.floor(center.z / span);
const startedAt = performance.now();
const jobs = [];
for (let z = centerZ - radius; z <= centerZ + radius; z += 1) {
  for (let x = centerX - radius; x <= centerX + radius; x += 1) {
    jobs.push(world.buildRegion({ level, x, z }).then((built) => ({ x, z, built })));
  }
}
let bytes = 0;
let quads = 0;
const times = [];
for (const { x, z, built } of await Promise.all(jobs)) {
  const region = decodeSceneRegion(built.bytes);
  const count = region.opaque.length / 3 + region.plants.length / 3 + region.translucent.length / 3;
  bytes += built.bytes.byteLength;
  quads += count;
  times.push(built.milliseconds);
  console.log(
    `L${level} ${x},${z}: ${built.milliseconds.toFixed(0)} ms, ${region.opaque.length / 3} opaque, ${region.plants.length / 3} plants, ${region.translucent.length / 3} translucent, y ${region.minY}..${region.maxY}`,
  );
}
times.sort((left, right) => left - right);
console.log(
  `${jobs.length} regions in ${(performance.now() - startedAt).toFixed(0)} ms wall, median ${times[times.length >> 1].toFixed(0)} ms, ${quads} quads, ${(bytes / 1024).toFixed(0)} KiB`,
);
await world.close();
