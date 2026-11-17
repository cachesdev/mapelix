import { resolve } from "node:path";
import {
  writeFixtureWorld,
  sectionRecord,
  biomeRecord,
} from "../../../packages/mapelix-scene-prototype/test/dimension-fixture";
import { modelFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/model-fixture";
import { caveFixtureRecords } from "../../../packages/mapelix-scene-prototype/test/cave-fixture";
import {
  makePng,
  packFiles,
  writePackFolder,
} from "../../../packages/mapelix-scene-prototype/test/synthetic-pack";

/** Generated block textures, never game assets: one flat color per block, unlike its map color. */
const TEXTURES: Record<string, readonly [number, number, number, number]> = {
  stone: [40, 120, 220, 255],
  dirt: [230, 200, 40, 255],
  oak_planks: [200, 40, 200, 255],
  quartz_block: [40, 200, 90, 255],
  red_concrete: [20, 20, 20, 255],
};

/** Writes the synthetic texture pack the test server offers. */
async function writeTexturePack(): Promise<void> {
  const names = Object.keys(TEXTURES);
  await writePackFolder(
    resolve("../../.local/dimension-textures"),
    packFiles({
      name: "Generated test textures",
      terrain: Object.fromEntries(
        names.map((name) => [name, { textures: `textures/blocks/${name}` }]),
      ),
      blocks: Object.fromEntries(names.map((name) => [name, { textures: name }])),
      images: Object.fromEntries(
        names.map((name) => [`textures/blocks/${name}.png`, makePng(16, TEXTURES[name]!)]),
      ),
    }),
  );
}

export default async function setupWorld(): Promise<void> {
  await writeTexturePack();
  if (process.env.MAPELIX_E2E_WORLD_DIRECTORY) return;
  await writeFixtureWorld(resolve("../../.local/dimension-world"), [
    ...modelFixtureRecords(),
    ...caveFixtureRecords(),
    sectionRecord(0, 2, 0, 5, (x, y, z) => {
      if (y === 80) return "minecraft:stone";
      if (y === 81 && z === 8 && x === 40) return "minecraft:chest";
      if (y === 81 && z === 8 && x === 41) return "minecraft:chest";
      if (y === 81 && z === 8 && x === 44) return "minecraft:barrel";
      if (x >= 36 && x <= 46 && z >= 4 && z <= 12 && y >= 81 && y <= 85) {
        if (y === 85 || x === 36 || x === 46 || z === 12 || (z === 4 && x !== 40))
          return "minecraft:oak_planks";
      }
      return "minecraft:air";
    }),
    biomeRecord(
      0,
      2,
      0,
      Array.from({ length: 24 }, () => 1),
    ),
    ...[4, 5].map((section) =>
      sectionRecord(0, 3, 0, section, (x, y, z) => {
        if (x === 54 && y === 74 && z === 8) return "minecraft:barrel";
        if (
          (x === 60 && y === 75 && z >= 8 && z <= 10) ||
          (x === 52 && y === 73 && z === 8) ||
          (x === 61 && y === 75 && z === 5) ||
          (x === 58 && y === 80 && z === 3)
        )
          return "minecraft:copper_ore";
        if (x >= 50 && x <= 58 && z >= 4 && z <= 11 && y >= 74 && y <= 77) return "minecraft:air";
        return y <= (x >= 62 ? 70 : 80) ? "minecraft:dirt" : "minecraft:air";
      }),
    ),
    biomeRecord(
      0,
      3,
      0,
      Array.from({ length: 24 }, () => 1),
    ),
    ...[4, 5].flatMap((cx) =>
      [0, 1].flatMap((cz) => [
        sectionRecord(0, cx, cz, 5, (x, y, z) => {
          const inside = x >= 66 && x <= 93 && z >= 2 && z <= 29;
          if (y === 80)
            return ((x >> 2) + (z >> 2)) % 2 ? "minecraft:red_concrete" : "minecraft:quartz_block";
          if (y > 80 && y <= 83) return inside ? "minecraft:water" : "minecraft:stone";
          return "minecraft:air";
        }),
        biomeRecord(
          0,
          cx,
          cz,
          Array.from({ length: 24 }, () => 1),
        ),
      ]),
    ),
  ]);
}
