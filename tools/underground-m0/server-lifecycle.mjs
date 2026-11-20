import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, output, rounded } from "./bench.mjs";
const c = new Client(),
  samples = [],
  cpu = process.cpuUsage(),
  start = performance.now();
const switches = Number(process.env.M0_SERVER_SWITCHES ?? 104);
if (!Number.isInteger(switches) || switches < 104 || switches % 4 !== 0)
  throw new Error(
    "M0_SERVER_SWITCHES must be a multiple of four, at least 104",
  );
const requests = [
  { dimension: "overworld", mode: "default", level: 0, x: -1, z: 0 },
  {
    dimension: "overworld",
    mode: "caves",
    minY: -64,
    maxY: 0,
    level: 0,
    x: -1,
    z: 0,
  },
  { dimension: "nether", mode: "default", level: 0, x: 0, z: 0 },
  { dimension: "the-end", mode: "default", level: 0, x: 0, z: 0 },
];
try {
  for (let i = 0; i < switches; i++) {
    const r = await c.build({
      ...requests[i % 4],
      collectGarbage: i % 4 === 3,
    });
    if (i % 4 === 3)
      samples.push({
        switches: i + 1,
        rssMiB: rounded(r.memory.rss / 1048576),
        workerHeapMiB: rounded(r.memory.heapUsed / 1048576),
        workerArrayBuffersMiB: rounded(r.memory.arrayBuffers / 1048576),
      });
  }
  const used = process.cpuUsage(cpu),
    result = {
      switches,
      method:
        "One M0 worker, shared sequential budget; one builder per visited dimension retained (bounded at three); GC at equal End checkpoints; real snapshot End is empty",
      samples,
      cpuMs: rounded((used.user + used.system) / 1000),
      wallMs: rounded(performance.now() - start),
    };
  writeFileSync(
    join(
      output,
      `server-lifecycle${switches === 104 ? "" : `-${switches}`}.json`,
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      ...result,
      samples: {
        first: samples[0],
        last: samples.at(-1),
        rssMin: Math.min(...samples.map((s) => s.rssMiB)),
        rssMax: Math.max(...samples.map((s) => s.rssMiB)),
      },
    }),
  );
} finally {
  await c.close();
}
