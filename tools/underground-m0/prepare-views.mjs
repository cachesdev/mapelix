import { stripTypeScriptTypes } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFixtureWorld } from "../../packages/mapelix-scene-prototype/test/dimension-fixture.ts";
import { PrototypeBuilder } from "./prototype.mjs";
import { directory, output } from "./bench.mjs";
const root = resolve(import.meta.dirname, "../.."),
  base = join(root, ".local/underground-m0");
const modelSource = stripTypeScriptTypes(
  readFileSync(
    join(root, "packages/mapelix-scene-prototype/test/model-fixture.ts"),
    "utf8",
  ),
).replace(
  '"./dimension-fixture.js"',
  JSON.stringify(
    pathToFileURL(
      join(root, "packages/mapelix-scene-prototype/test/dimension-fixture.ts"),
    ).href,
  ),
);
const { modelFixtureRecords } = await import(
  "data:text/javascript;base64," + Buffer.from(modelSource).toString("base64")
);
const endFixture = join(base, "end-fixture");
await writeFixtureWorld(endFixture, modelFixtureRecords());
const views = [
  {
    name: "surface",
    dimension: "overworld",
    mode: "default",
    ceilingY: 320,
    spawn: { x: -32, y: 77, z: 32 },
  },
  {
    name: "caves",
    dimension: "overworld",
    mode: "caves",
    minY: -64,
    maxY: 0,
    ceilingY: 0,
    spawn: { x: -32, y: -32, z: 32 },
  },
  {
    name: "nether",
    dimension: "nether",
    mode: "default",
    ceilingY: 96,
    spawn: { x: 32, y: 59, z: 32 },
  },
  {
    name: "end",
    dimension: "the-end",
    mode: "default",
    ceilingY: 256,
    spawn: { x: 32, y: 80, z: 32 },
  },
];
mkdirSync(join(output, "payloads"), { recursive: true });
const assets = [];
for (const view of views) {
  const b = new PrototypeBuilder(
    view.name === "end" ? endFixture : directory,
    view.dimension,
  );
  try {
    for (const level of [0, 1])
      for (const x of [-1, 0])
        for (const z of [-1, 0]) {
          const request = { ...view, level, x, z },
            bytes = b.build(request),
            file = `${view.name}-${level}-${x}-${z}.bin`;
          writeFileSync(join(output, "payloads", file), bytes);
          assets.push({
            file,
            name: view.name,
            level,
            x,
            z,
            bytes: bytes.length,
          });
        }
  } finally {
    b.close();
  }
}
writeFileSync(
  join(output, "views.json"),
  JSON.stringify(
    {
      views,
      assets,
      endSource: "Generated Bedrock catalog; actual snapshot has no End chunks",
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    preparedPayloads: assets.length,
    bytes: assets.reduce((n, a) => n + a.bytes, 0),
  }),
);
