import {
  bedEntityRecord,
  biomeRecord,
  sectionRecord,
  type FixtureBlock,
  type FixtureRecord,
} from "./dimension-fixture.js";

/** A disposable visual catalog. It never opens, scans or changes a user's world. */
export function modelFixtureRecords(): FixtureRecord[] {
  const records: FixtureRecord[] = [];
  const samples = new Map<string, FixtureBlock>();
  const put = (
    x: number,
    y: number,
    z: number,
    name: string,
    states: Record<string, number | string> = {},
  ) => samples.set(`${x},${y},${z}`, { name: `minecraft:${name}`, states });
  for (let direction = 0; direction < 4; direction++) {
    const x = 4 + direction * 6;
    put(x, 80, 6, "oak_stairs", { weirdo_direction: direction });
    put(x, 80, 12, "quartz_stairs", { weirdo_direction: direction, upside_down_bit: 1 });
    put(x, 80, 18, "purpur_stairs", {
      weirdo_direction: direction,
      "minecraft:corner": "outer_left",
    });
    put(x, 80, 24, "stone_brick_stairs", {
      weirdo_direction: direction,
      "minecraft:corner": "inner_right",
    });
    for (const upper_block_bit of [0, 1])
      put(x, 80 + upper_block_bit, 30, "wooden_door", {
        direction,
        open_bit: direction & 1,
        upper_block_bit,
        door_hinge_bit: direction >> 1,
      });
    put(x, 80, 36, "trapdoor", {
      direction,
      open_bit: direction & 1,
      upside_down_bit: direction >> 1,
    });
    put(x, 80, 42, "bed", { direction, head_piece_bit: 1 });
  }
  for (let x = 3; x < 26; x++) if (x !== 14) put(x, 80, 48, "oak_fence");
  put(14, 80, 48, "oak_fence_gate", { direction: 0, open_bit: 1 });
  for (let y = 80; y < 84; y++) put(6, y, 55, "scaffolding", { stability: 1 });
  for (let y = 80; y < 84; y++) put(14, y, 55, "chorus_plant");
  put(14, 84, 55, "chorus_flower");
  for (const x of [13, 15]) put(x, 82, 55, "chorus_plant");
  for (const [index, block] of [
    "flower_pot",
    "lantern",
    "soul_lantern",
    "candle",
    "cake",
    "cauldron",
    "hopper",
    "end_rod",
    "chain",
    "iron_bars",
    "glass_pane",
    "ladder",
  ].entries()) {
    put(30 + (index % 6) * 5, 80, 46 + Math.floor(index / 6) * 9, block);
  }
  for (let depth = 0; depth < 8; depth++)
    put(34 + depth * 3, 80, 35, "flowing_lava", { liquid_depth: depth });
  // A tall fall and its pool let the browser inspect side animation and horizontal convection.
  for (let y = 80; y < 91; y++) put(50, y, 20, "flowing_lava", { liquid_depth: 8 });
  for (const dimension of [0, 1, 2])
    for (let cz = 0; cz < 4; cz++)
      for (let cx = 0; cx < 4; cx++) {
        const ground =
          dimension === 0 ? "grass_block" : dimension === 1 ? "netherrack" : "end_stone";
        records.push(
          sectionRecord(dimension, cx, cz, 4, (x, y, z) => {
            if (y < 79) return "minecraft:stone";
            if (x >= 34 && x < 60 && z >= 6 && z < 29) return "minecraft:lava";
            if (x >= 34 && x < 42 && z >= 39 && z < 43) return "minecraft:magma";
            return `minecraft:${ground}`;
          }),
        );
        records.push(
          sectionRecord(
            dimension,
            cx,
            cz,
            5,
            (x, y, z) => samples.get(`${x},${y},${z}`) ?? "minecraft:air",
          ),
        );
        records.push(
          biomeRecord(
            dimension,
            cx,
            cz,
            Array<number>(dimension === 0 ? 24 : dimension === 1 ? 8 : 16).fill(
              dimension === 0 ? 1 : dimension === 1 ? 179 : 9,
            ),
          ),
        );
        const beds = [0, 1, 2, 3].map((direction) => ({
          x: 4 + direction * 6,
          y: 80,
          z: 42,
          color: [14, 11, 4, 13][direction]!,
        }));
        records.push(
          bedEntityRecord(
            dimension,
            cx,
            cz,
            beds.filter((bed) => Math.floor(bed.x / 16) === cx && Math.floor(bed.z / 16) === cz),
          ),
        );
        if (dimension === 1) records.push(sectionRecord(dimension, cx, cz, 7, "minecraft:bedrock"));
      }
  // Match the positive-coordinate pool with negative-X/Z pools for shader regression tests.
  for (const dimension of [0, 1, 2])
    for (const [centerX, centerZ] of [
      [-48, 16],
      [48, -48],
      [-48, -48],
    ] as const)
      for (let cz = Math.floor((centerZ - 12) / 16); cz <= Math.floor((centerZ + 11) / 16); cz++)
        for (
          let cx = Math.floor((centerX - 12) / 16);
          cx <= Math.floor((centerX + 11) / 16);
          cx++
        ) {
          records.push(
            sectionRecord(dimension, cx, cz, 4, (x, y, z) => {
              if (y < 79) return "minecraft:stone";
              return Math.abs(x - centerX) < 12 && Math.abs(z - centerZ) < 12
                ? "minecraft:lava"
                : "minecraft:stone";
            }),
          );
        }
  return records;
}
