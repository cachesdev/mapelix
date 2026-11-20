import { biomeRecord, sectionRecord, type FixtureRecord } from "./dimension-fixture.js";

/** A sealed negative-Y tunnel and cut-boundary ores, beneath the dimension fixture. */
export function caveFixtureRecords(): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  for (let x = 0; x < 2; x++)
    for (let z = 0; z < 2; z++) {
      for (let section = -4; section < 0; section++) {
        records.push(
          sectionRecord(0, x, z, section, (wx, y, wz) => {
            if (y === -63 && wx === 14 && wz === 20) return "minecraft:deepslate_diamond_ore";
            if (y === -60 && wz === 20) {
              if (wx === 12) return "minecraft:chest";
              if (wx === 14) return "minecraft:mob_spawner";
              if (wx === 16) return "minecraft:trial_spawner";
              if (wx === 18) return "minecraft:vault";
              if (wx === 20) return "minecraft:budding_amethyst";
              if (wx === 22) return "minecraft:sculk_shrieker";
            }
            if (y === -32 && wz === 16) return "minecraft:air";
            if ((y === -48 || y === -47) && wz >= 8 && wz < 10) return "minecraft:air";
            if (y >= -60 && y <= -53 && wx >= 4 && wx < 28 && wz >= 14 && wz < 28) {
              if (y === -60 && wx < 10) return "minecraft:lava";
              if (y === -60 && wx >= 24) return "minecraft:water";
              return "minecraft:air";
            }
            if (y === -33) return "minecraft:diamond_ore";
            if (y === -32) return "minecraft:gold_ore";
            return "minecraft:deepslate";
          }),
        );
      }
      records.push(
        biomeRecord(
          0,
          x,
          z,
          Array.from({ length: 24 }, (_, i) => (i < 4 ? 175 : 1)),
        ),
      );
    }
  return records;
}
