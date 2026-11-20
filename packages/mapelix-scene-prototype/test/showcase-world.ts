// Writes a generated world with a sample of every block that has its own model, sheet of parts
// or texture rule, plus the blocks still drawn as cubes or not at all, to check them by eye.
// Usage, from this package: node test/showcase-world.ts <empty world directory>
import {
  bedEntityRecord,
  biomeRecord,
  sectionRecord,
  writeFixtureWorld,
  type FixtureBlock,
  type FixtureRecord,
} from "./dimension-fixture.ts";

const target = process.argv[2];
if (target === undefined) throw new Error("Usage: node test/showcase-world.ts <directory>");

const CHUNKS_X = 4;
const CHUNKS_Z = 6;
const FLOOR = 64;
const blocks = new Map<string, FixtureBlock>();
const put = (x: number, y: number, z: number, block: FixtureBlock) =>
  blocks.set(`${x},${y},${z}`, block);
const b = (name: string, states: Record<string, number | string> = {}): FixtureBlock => ({
  name: `minecraft:${name}`,
  states,
});
/** One row of samples, three blocks apart along x. */
const row = (z: number, items: readonly FixtureBlock[], y = FLOOR) =>
  items.forEach((item, i) => put(3 + i * 3, y, z, item));
const CARDINAL = ["south", "west", "north", "east"] as const;
/** The neighbor on a side, in the `direction` order: south, west, north, east. */
const SIDE = [
  [0, 1],
  [-1, 0],
  [0, -1],
  [1, 0],
] as const;

// Lanterns, standing and hanging from stone.
const LANTERNS = [
  "lantern",
  "soul_lantern",
  "copper_lantern",
  "exposed_copper_lantern",
  "oxidized_copper_lantern",
];
row(
  4,
  LANTERNS.map((name) => b(name, { hanging: 0 })),
);
LANTERNS.forEach((name, i) => {
  put(3 + i * 3, FLOOR + 3, 8, "minecraft:stone");
  put(3 + i * 3, FLOOR + 2, 8, b(name, { hanging: 1 }));
});

// Torches standing, then on the four sides of a stone block.
const TORCHES = ["torch", "redstone_torch", "soul_torch", "copper_torch"];
row(
  12,
  TORCHES.map((name) => b(name, { torch_facing_direction: "top" })),
);
put(18, FLOOR, 12, "minecraft:stone");
for (const [direction, [dx, dz]] of SIDE.entries()) {
  // `torch_facing_direction` names the side the wall is on.
  put(18 - dx, FLOOR, 12 - dz, b("torch", { torch_facing_direction: CARDINAL[direction]! }));
}

// Chains: standing, and lying along x and z.
for (const y of [FLOOR, FLOOR + 1, FLOOR + 2]) put(3, y, 16, b("iron_chain", { pillar_axis: "y" }));
for (const x of [6, 7, 8]) put(x, FLOOR, 16, b("iron_chain", { pillar_axis: "x" }));
for (const z of [15, 16, 17]) put(11, FLOOR, z, b("iron_chain", { pillar_axis: "z" }));

row(
  20,
  [0, 1, 2, 3, 4, 5].map((facing) => b("end_rod", { facing_direction: facing })),
);
row(24, [
  ...[0, 1, 2, 3].map((candles) => b("candle", { candles, lit: 1 })),
  b("red_candle", { candles: 2, lit: 0 }),
  b("blue_candle", { candles: 3, lit: 1 }),
]);
row(28, [
  b("flower_pot"),
  b("lightning_rod", { facing_direction: 1 }),
  b("lightning_rod", { facing_direction: 2 }),
  b("lightning_rod", { facing_direction: 5 }),
  b("red_shrub"),
  b("shelf_mushroom", { "minecraft:cardinal_direction": "north" }),
]);
// The shelf mushroom grows on the log on the side opposite its free side.
put(18, FLOOR, 29, "minecraft:oak_log");

// Beds in the four directions, with their colors in block entities.
const beds: { x: number; y: number; z: number; color: number }[] = [];
[14, 11, 0, 5, 4, 10, 13, 15].forEach((color, i) => {
  const direction = i % 4;
  const x = 4 + (i % 4) * 4;
  const z = i < 4 ? 33 : 38;
  const [dx, dz] = SIDE[direction]!;
  put(x, FLOOR, z, b("bed", { direction, head_piece_bit: 0, occupied_bit: 0 }));
  put(x + dx, FLOOR, z + dz, b("bed", { direction, head_piece_bit: 1, occupied_bit: 0 }));
  beds.push({ x, y: FLOOR, z, color }, { x: x + dx, y: FLOOR, z: z + dz, color });
});

// Anvils of every damage, facing the four ways.
row(43, [
  ...CARDINAL.map((side) => b("anvil", { "minecraft:cardinal_direction": side })),
  b("chipped_anvil", { "minecraft:cardinal_direction": "south" }),
  b("damaged_anvil", { "minecraft:cardinal_direction": "east" }),
]);
// Grindstones standing, hanging from stone, and on a wall behind them.
row(
  47,
  [0, 1, 2, 3].map((direction) => b("grindstone", { direction, attachment: "standing" })),
);
for (let direction = 0; direction < 4; direction++) {
  const x = 15 + direction * 3;
  put(x, FLOOR + 3, 47, "minecraft:stone");
  put(x, FLOOR + 2, 47, b("grindstone", { direction, attachment: "hanging" }));
}
for (let direction = 0; direction < 4; direction++) {
  const x = 3 + direction * 4;
  const [dx, dz] = SIDE[direction]!;
  put(x, FLOOR, 51, b("grindstone", { direction, attachment: "side" }));
  put(x - dx, FLOOR, 51 - dz, "minecraft:stone");
}

// Huge mushroom faces, the Nether portal on both axes, and older shaped blocks.
row(55, [
  b("brown_mushroom_block", { huge_mushroom_bits: 14 }),
  b("red_mushroom_block", { huge_mushroom_bits: 14 }),
  b("brown_mushroom_block", { huge_mushroom_bits: 5 }),
  b("mushroom_stem", { huge_mushroom_bits: 15 }),
]);
for (const y of [FLOOR, FLOOR + 1]) {
  put(18, y, 55, b("portal", { portal_axis: "x" }));
  put(22, y, 55, b("portal", { portal_axis: "z" }));
}
row(59, [
  b("oak_stairs", { weirdo_direction: 0, upside_down_bit: 0 }),
  b("oak_fence"),
  b("cobblestone_wall"),
  b("glass_pane"),
  b("trapdoor", { direction: 0, open_bit: 0, upside_down_bit: 0 }),
  b("fence_gate", { direction: 0, open_bit: 0 }),
  b("cake", { bite_counter: 2 }),
  b("cauldron"),
  b("hopper"),
  b("scaffolding", { stability: 0 }),
  b("chorus_flower"),
  b("bee_nest", { direction: 0 }),
]);
put(42, FLOOR, 59, b("wooden_door", { direction: 0, upper_block_bit: 0 }));
put(42, FLOOR + 1, 59, b("wooden_door", { direction: 0, upper_block_bit: 1 }));

// Stonecutters and campfires, lit and out, both ways round.
row(61, [
  ...["south", "east"].map((side) =>
    b("stonecutter_block", { "minecraft:cardinal_direction": side }),
  ),
  ...["south", "east"].flatMap((side) =>
    [0, 1].map((extinguished) =>
      b("campfire", { "minecraft:cardinal_direction": side, extinguished }),
    ),
  ),
  b("soul_campfire", { "minecraft:cardinal_direction": "south", extinguished: 0 }),
]);

// Enchanting table, end portal frame, composters filling up, lecterns facing the four ways.
row(57, [
  b("enchanting_table"),
  b("end_portal_frame", { direction: 0, end_portal_eye_bit: 0 }),
  ...[0, 3, 7, 8].map((composter_fill_level) => b("composter", { composter_fill_level })),
  ...[0, 1, 2, 3].map((direction) => b("lectern", { direction, powered_bit: 0 })),
]);

// Brewing stand, and bells on the floor, from the ceiling, on a wall and between walls.
row(53, [
  b("brewing_stand"),
  ...[0, 1].map((direction) => b("bell", { attachment: "standing", direction })),
]);
put(12, FLOOR + 3, 53, "minecraft:stone");
put(12, FLOOR + 2, 53, b("bell", { attachment: "hanging", direction: 0 }));
put(15, FLOOR, 53, b("bell", { attachment: "side", direction: 0 }));
put(15, FLOOR, 52, "minecraft:stone");
put(18, FLOOR, 53, b("bell", { attachment: "multiple", direction: 0 }));
put(18, FLOOR, 52, "minecraft:stone");
put(18, FLOOR, 54, "minecraft:stone");

// Buttons, levers, signs, banners, heads and frames: on the floor, then against stone.
row(67, [
  b("stone_button", { facing_direction: 1, button_pressed_bit: 0 }),
  b("lever", { lever_direction: "up_north_south", open_bit: 0 }),
  b("standing_sign", { ground_sign_direction: 0 }),
  b("standing_banner", { ground_sign_direction: 4 }),
  b("skull", { facing_direction: 1 }),
  b("frame", { facing_direction: 1 }),
]);
[
  b("stone_button", { facing_direction: 3, button_pressed_bit: 0 }),
  b("lever", { lever_direction: "south", open_bit: 0 }),
  b("wall_sign", { facing_direction: 3 }),
  b("wall_banner", { facing_direction: 3 }),
  b("skull", { facing_direction: 3 }),
  b("frame", { facing_direction: 3 }),
].forEach((block, i) => {
  put(24 + i * 3, FLOOR, 66, "minecraft:stone");
  put(24 + i * 3, FLOOR, 67, block);
});

// Full cubes to check the way their textures face.

row(
  64,
  ["smithing_table", "loom", "chiseled_bookshelf"].map((name) => b(name)),
);
// Crossed planes, the End portal and sea pickles.
row(70, [
  b("web"),
  b("fire"),
  b("soul_fire"),
  b("cave_vines_head_with_berries"),
  b("small_amethyst_bud", { facing_direction: 1 }),
  b("amethyst_cluster", { facing_direction: 1 }),
  b("end_portal"),
  ...[0, 1, 2, 3].map((cluster_count) => b("sea_pickle", { cluster_count, dead_bit: 0 })),
]);
// Dripstone growing up from the floor and down from stone, tip to base.
["tip", "frustum", "base"].forEach((dripstone_thickness, i) =>
  put(36, FLOOR + 2 - i, 70, b("pointed_dripstone", { dripstone_thickness, hanging: 0 })),
);
put(39, FLOOR + 3, 70, "minecraft:stone");
["base", "frustum", "tip"].forEach((dripstone_thickness, i) =>
  put(39, FLOOR + 2 - i, 70, b("pointed_dripstone", { dripstone_thickness, hanging: 1 })),
);
// An amethyst cluster on a wall.
put(42, FLOOR, 71, "minecraft:amethyst_block");
put(42, FLOOR, 70, b("amethyst_cluster", { facing_direction: 2 }));
// Plants that hang or cling: vines and lichen against stone, cave vines under it.
put(3, FLOOR, 75, "minecraft:stone");
put(3, FLOOR, 74, b("vine", { vine_direction_bits: 1 }));
put(6, FLOOR, 75, "minecraft:stone");
put(6, FLOOR, 74, b("glow_lichen", { multi_face_direction_bits: 4 }));
put(9, FLOOR + 2, 74, "minecraft:stone");
put(9, FLOOR + 1, 74, b("cave_vines_head_with_berries"));

// Rails: straight both ways, the four curves, then powered rails off and on.
row(78, [
  ...[0, 1, 6, 7, 8, 9].map((rail_direction) => b("rail", { rail_direction })),
  ...[0, 1].map((rail_data_bit) => b("golden_rail", { rail_direction: 0, rail_data_bit })),
]);

// Water plants: fixed green lily pads, and vines on every side plus a hanging vine.
for (let z = 76; z <= 83; z++)
  for (let x = 36; x <= 59; x++) put(x, FLOOR - 1, z, "minecraft:water");
for (const z of [78, 82]) for (const x of [39, 45, 51, 57]) put(x, FLOOR, z, b("waterlily"));
SIDE.forEach(([dx, dz], index) => {
  const x = 4 + index * 6;
  put(x + dx, FLOOR, 82 + dz, "minecraft:stone");
  put(x, FLOOR, 82, b("vine", { vine_direction_bits: 1 << index }));
});
put(28, FLOOR + 1, 82, "minecraft:stone");
put(28, FLOOR, 82, b("vine", { vine_direction_bits: 0 }));

// All 16 saved banner base dyes, standing and on a wall. Base 0 is black, 15 white.
const banners: { x: number; y: number; z: number; base: number; id: string }[] = [];
for (let base = 0; base < 16; base++) {
  const x = 3 + base * 3;
  put(x, FLOOR, 86, b("standing_banner", { ground_sign_direction: 0 }));
  put(x, FLOOR, 89, "minecraft:stone");
  put(x, FLOOR, 90, b("wall_banner", { facing_direction: 3 }));
  for (const z of [86, 90]) banners.push({ x, y: FLOOR, z, base, id: "Banner" });
}

// Gold floor under the samples still to do, so the invisible ones can be found.
const todo = (x: number, z: number) =>
  z === 64 && [...blocks.keys()].some((key) => key.startsWith(`${x},`) && key.endsWith(`,${z}`));

const records: FixtureRecord[] = [];
for (let cz = 0; cz < CHUNKS_Z; cz++)
  for (let cx = 0; cx < CHUNKS_X; cx++) {
    records.push(
      sectionRecord(
        0,
        cx,
        cz,
        3,
        (x, y, z) =>
          blocks.get(`${x},${y},${z}`) ??
          (y !== FLOOR - 1
            ? "minecraft:stone"
            : todo(x, z)
              ? "minecraft:gold_block"
              : "minecraft:grass_block"),
      ),
    );
    records.push(
      sectionRecord(0, cx, cz, 4, (x, y, z) => blocks.get(`${x},${y},${z}`) ?? "minecraft:air"),
    );
    records.push(biomeRecord(0, cx, cz, Array<number>(24).fill(1)));
    const inChunk = beds.filter((bed) => bed.x >> 4 === cx && bed.z >> 4 === cz);
    const cloth = banners.filter((banner) => banner.x >> 4 === cx && banner.z >> 4 === cz);
    if (inChunk.length + cloth.length > 0)
      records.push(bedEntityRecord(0, cx, cz, [...inChunk, ...cloth]));
  }
await writeFixtureWorld(target, records);
console.log("wrote", target, blocks.size, "blocks");
