import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import {
  sectionRecord,
  writeFixtureWorld,
} from "../../packages/mapelix-scene-prototype/test/dimension-fixture.ts";
import { RegionBuilder } from "../../packages/mapelix-scene-prototype/dist/node/region-builder.js";
import { PrototypeBuilder, context, key } from "./prototype.mjs";
import {
  decodeSceneRegion,
  unpackQuad,
  Face,
} from "../../packages/mapelix-scene-prototype/dist/format.js";
const base = resolve(import.meta.dirname, "../../.local/underground-m0");
mkdirSync(base, { recursive: true });
const world = join(base, "fixture");
const records = [];
for (const dimension of [0, 1, 2])
  for (let cx = 0; cx < 2; cx++)
    for (let cz = 0; cz < 2; cz++)
      for (let sy = dimension === 0 ? -4 : 0; sy < 5; sy++)
        records.push(
          sectionRecord(dimension, cx, cz, sy, (x, y, z) => {
            if (y >= 48) return "minecraft:air";
            if ((y === -48 || y === -47) && z >= 8 && z < 10)
              return "minecraft:air";
            if (y === -32 && z === 16) return "minecraft:air";
            if (y >= -20 && y < -12 && x >= 8 && x < 16 && z >= 8 && z < 16)
              return "minecraft:air";
            if (y === -33) return "minecraft:diamond_ore";
            if (y === -32) return "minecraft:gold_ore";
            return "minecraft:stone";
          }),
        );
await writeFixtureWorld(world, records);
let assertions = 0;
function check(condition, message) {
  assert(condition, message);
  assertions++;
}
for (const dimension of ["overworld", "nether", "the-end"]) {
  const before = new RegionBuilder({ directory: world, dimension });
  const after = new PrototypeBuilder(world, dimension);
  try {
    const ceilings =
      dimension === "overworld"
        ? [-48, -32, -16, 0, 16, 32, 64, 320]
        : dimension === "nether"
          ? [16, 32, 64, 96, 128]
          : [16, 64, 128, 256];
    for (const ceilingY of ceilings)
      for (const level of [0, 1, 2]) {
        const q = { level, x: 0, z: 0, ceilingY };
        const a = before.build(q),
          b = after.build({ ...q, maxY: ceilingY });
        check(
          Buffer.from(a).equals(Buffer.from(b)),
          `legacy bytes ${dimension} ceiling ${ceilingY} L${level}`,
        );
        check(
          key(dimension, q) ===
            key(dimension, { level, x: 0, z: 0, maxY: ceilingY }),
          "canonical alias cache key",
        );
        const r = decodeSceneRegion(b);
        check(r.maxY <= ceilingY, "exclusive upper bound");
      }
    if (dimension === "overworld") {
      const window = {
        mode: "caves",
        minY: -64,
        maxY: -32,
        level: 0,
        x: 0,
        z: 0,
      };
      const r = decodeSceneRegion(after.build(window));
      const quads = Array.from({ length: r.opaque.length / 3 }, (_, i) =>
        unpackQuad(r.opaque, i),
      );
      check(quads.length > 0 && r.minY < 0, "negative cave geometry present");
      check(
        quads.every((q) => q.y >= -64 && q.y < -32),
        "no owner at exclusive max",
      );
      check(
        quads.some((q) => q.y === -46 && q.face === Face.NegativeY),
        "enclosed tunnel ceiling retained",
      );
      const boundaryTops = quads.filter(
        (q) => q.y === -33 && q.face === Face.PositiveY,
      );
      check(
        boundaryTops.length > 0 &&
          boundaryTops.every((q) => q.z === 16 && q.height === 1),
        "only real source air exposes the max-1 top; solid cut boundary adds no artificial cap",
      );
      check(
        key(dimension, window) !==
          key(dimension, { level: 0, x: 0, z: 0, ceilingY: -32 }),
        "visibility strategies isolate equal-bound caches",
      );
      for (const maxY of [-65, -64, -63, -33, -31, 321, 336])
        assert.throws(() => context(dimension, { mode: "default", maxY }));
      assert.throws(() => context(dimension, { ceilingY: 0, maxY: 16 }));
      const thin = decodeSceneRegion(
        after.build({ ...window, minY: -48, maxY: -40 }),
      );
      check(
        thin.minY >= -48 && thin.maxY <= -40,
        "8-block slice has exact boundaries",
      );
      for (const level of [0, 1, 2]) {
        const passage = decodeSceneRegion(
          after.build({ ...window, maxY: 0, level }),
        );
        let visible = false;
        for (let i = 0; i < passage.opaque.length / 3; i++) {
          const q = unpackQuad(passage.opaque, i),
            s = passage.cellSize;
          if (
            q.face === Face.PositiveY &&
            (q.y + q.box.size / 16) * s === -32 &&
            10 >= q.x * s &&
            10 < (q.x + q.width) * s &&
            16 >= q.z * s &&
            16 < (q.z + q.height) * s
          )
            visible = true;
        }
        check(
          visible === level < 2,
          `one-block passage remains at L${level < 2 ? "0/1" : "2 closes it"}`,
        );
      }
    }
  } finally {
    before.close();
    after.close();
  }
}
writeFileSync(
  join(base, "validation.json"),
  JSON.stringify(
    {
      assertions,
      legacyAlias: "maxY = ceilingY (exclusive), never +1",
      invalidCases: 8,
      passed: true,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ validation: "passed", assertions }));
