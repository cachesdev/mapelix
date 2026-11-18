import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";
import { Face } from "../format.js";
import type { ModelBounds } from "../model-boxes.js";
import type { PartSheet } from "../textures/sheet-faces.js";
export type { ModelBounds } from "../model-boxes.js";

/** Axis-aligned model bounds, in sixteenths of a block: low xyz, then high xyz. */
export interface ModelPart {
  readonly bounds: ModelBounds;
  /** An untinted detail, such as a bed leg or pillow; otherwise use the block palette. */
  readonly color?: number;
  /**
   * Where the part's faces read the block's texture when it is a sheet of parts, as for
   * lanterns and candles; otherwise each face reads the texture at its own position.
   */
  readonly sheet?: PartSheet;
  /** A colored part that still takes the block's texture where textures show, as a pillow. */
  readonly textured?: true;
  /**
   * For each face, in `Face` order, the block face whose texture it reads, so that parts of one
   * block can show different textures, as a grindstone's legs, pivots and wheel do.
   */
  readonly faces?: readonly number[];
}

export type ModelFamily =
  | "stairs"
  | "door"
  | "trapdoor"
  | "fence"
  | "gate"
  | "wall"
  | "pane"
  | "scaffolding"
  | "bed"
  | "chorus"
  | "chorus-flower"
  | "lantern"
  | "pot"
  | "rod"
  | "lightning-rod"
  | "portal"
  | "shelf-mushroom"
  | "wall-torch"
  | "chain"
  | "ladder"
  | "candle"
  | "cake"
  | "cauldron"
  | "hopper"
  | "anvil"
  | "grindstone"
  | "stonecutter"
  | "campfire"
  | "lectern"
  | "composter"
  | "low-box";

export interface BlockModel {
  readonly family: ModelFamily;
  readonly block: string;
  readonly states: LittleEndianNbtCompoundValue;
}
export interface ModelNeighbor {
  readonly opaque: boolean;
  readonly glass?: boolean;
  readonly model?: BlockModel | undefined;
}
export type ModelNeighbors = (dx: number, dy: number, dz: number) => ModelNeighbor;

/** State names come from the supplied Bedrock 1.26.60.5 block registry. */
export const MODEL_STATES = [
  "direction",
  "weirdo_direction",
  "minecraft:cardinal_direction",
  "minecraft:corner",
  "open_bit",
  "door_hinge_bit",
  "upper_block_bit",
  "upside_down_bit",
  "head_piece_bit",
  "minecraft:connection_east",
  "minecraft:connection_west",
  "minecraft:connection_south",
  "minecraft:connection_north",
  "minecraft:connection_up",
  "minecraft:connection_down",
  "wall_connection_type_east",
  "wall_connection_type_west",
  "wall_connection_type_south",
  "wall_connection_type_north",
  "wall_post_bit",
  "stability",
  "hanging",
  "facing_direction",
  "pillar_axis",
  "portal_axis",
  "torch_facing_direction",
  "candles",
  "lit",
  "bite_counter",
  "attachment",
  "extinguished",
  "composter_fill_level",
  "liquid_depth",
] as const;

/** Copper blocks at any oxidation stage, waxed or not: `copper_`, `waxed_oxidized_copper_`... */
export const COPPER_PREFIX = "(?:waxed_)?(?:exposed_|weathered_|oxidized_)?copper_";
const LANTERN = new RegExp(`^(?:soul_|${COPPER_PREFIX})?lantern$`);
const BARS = new RegExp(`^(?:iron_|${COPPER_PREFIX})bars$`);
/** `torch_facing_direction` values of torches on a wall: the side the wall is on. */
const WALL_SIDES: ReadonlySet<string> = new Set(["north", "south", "east", "west"]);
const LIGHTNING_ROD = /^(?:waxed_)?(?:exposed_|weathered_|oxidized_)?lightning_rod$/;
const ANVIL = /^(?:chipped_|damaged_)?anvil$/;

export function resolveBlockModel(
  block: string,
  states: LittleEndianNbtCompoundValue,
): BlockModel | undefined {
  let family: ModelFamily | undefined;
  if (block.endsWith("_stairs")) family = "stairs";
  else if (/(?:^|_)trapdoor$/.test(block)) family = "trapdoor";
  else if (/(?:^|_)door$/.test(block)) family = "door";
  else if (/(?:^|_)fence_gate$/.test(block)) family = "gate";
  else if (/(?:^|_)fence$/.test(block)) family = "fence";
  else if (block.endsWith("_wall")) family = "wall";
  else if (block.endsWith("glass_pane") || BARS.test(block)) family = "pane";
  else if (block === "scaffolding") family = "scaffolding";
  else if (block === "bed" || block.endsWith("_bed")) family = "bed";
  else if (block === "chorus_plant") family = "chorus";
  else if (block === "chorus_flower") family = "chorus-flower";
  else if (LANTERN.test(block)) family = "lantern";
  else if (block === "flower_pot") family = "pot";
  else if (block === "end_rod") family = "rod";
  else if (LIGHTNING_ROD.test(block)) family = "lightning-rod";
  else if (block === "portal") family = "portal";
  else if (block === "shelf_mushroom") family = "shelf-mushroom";
  else if (/(?:^|_)torch$/.test(block) && WALL_SIDES.has(String(states.torch_facing_direction)))
    family = "wall-torch";
  else if (block === "chain" || block.endsWith("_chain")) family = "chain";
  else if (block === "ladder") family = "ladder";
  else if (/(?:^|_)candle$/.test(block)) family = "candle";
  else if (block === "cake" || block === "candle_cake") family = "cake";
  else if (block === "cauldron" || block === "lava_cauldron") family = "cauldron";
  else if (block === "hopper") family = "hopper";
  else if (ANVIL.test(block)) family = "anvil";
  else if (block === "grindstone") family = "grindstone";
  else if (block === "stonecutter_block") family = "stonecutter";
  else if (block === "campfire" || block === "soul_campfire") family = "campfire";
  else if (block === "lectern") family = "lectern";
  else if (block === "composter") family = "composter";
  else if (block === "enchanting_table" || block === "end_portal_frame") family = "low-box";
  if (family === undefined) return undefined;
  const modelStates = Object.fromEntries(
    MODEL_STATES.flatMap((key) => (states[key] === undefined ? [] : [[key, states[key]]])),
  );
  return { family, block, states: modelStates };
}

const EMPTY_NEIGHBORS: ModelNeighbors = () => ({ opaque: false });
// Horizontal directions in Face order: east, west, south, north.
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
const CONNECTIONS = ["east", "west", "south", "north"] as const;
const part = (bounds: ModelBounds, color?: number): ModelPart =>
  color === undefined ? { bounds } : { bounds, color };
const sheetPart = (bounds: ModelBounds, sheet: PartSheet): ModelPart => ({ bounds, sheet });

/** Rectangles of the game's sheets of parts, as the vanilla pack lays them out. */
const LANTERN_BODY: PartSheet = { side: [0, 2], top: [0, 9] };
const LANTERN_CAP: PartSheet = { side: [1, 0], top: [1, 10] };
const LANTERN_CHAIN: PartSheet = { side: [11, 1] };
const CANDLE: PartSheet = { side: [0, 8], top: [0, 6], bottom: [0, 14] };
const POT_FLOOR: PartSheet = { side: [5, 15], top: [5, 10] };
const END_ROD_BASE: PartSheet = { side: [2, 6], top: [2, 2] };
const LIGHTNING_ROD_TIP: PartSheet = { side: [0, 0] };
/** Rods and chains through the middle of the block, by axis. */
const ROD_BOUNDS: Readonly<Record<"x" | "y" | "z", ModelBounds>> = {
  x: [0, 7, 7, 16, 9, 9],
  y: [7, 0, 7, 9, 16, 9],
  z: [7, 7, 0, 9, 9, 16],
};
/** An anvil with its top along z: base, neck, waist and top. */
const ANVIL_PARTS: readonly ModelBounds[] = [
  [2, 0, 2, 14, 4, 14],
  [4, 4, 3, 12, 5, 13],
  [6, 5, 4, 10, 10, 12],
  [3, 10, 0, 13, 16, 16],
];
/** A standing grindstone with its axle along x: two legs, two pivots, and the wheel. */
const GRINDSTONE_LEGS: readonly ModelBounds[] = [
  [2, 0, 6, 4, 7, 10],
  [12, 0, 6, 14, 7, 10],
];
const GRINDSTONE_PIVOTS: readonly ModelBounds[] = [
  [2, 7, 5, 4, 13, 11],
  [12, 7, 5, 14, 13, 11],
];
const GRINDSTONE_WHEEL: ModelBounds = [4, 4, 2, 12, 16, 14];
const isSet = (value: unknown): boolean => value === 1 || value === true;
const numberState = (s: LittleEndianNbtCompoundValue, key: string, fallback = 0): number =>
  typeof s[key] === "number" ? s[key] : fallback;

/** Rotation from a model pointing south, clockwise as seen from above. */
export function modelFacing(states: LittleEndianNbtCompoundValue, stairs = false): number {
  const cardinal = states["minecraft:cardinal_direction"];
  if (typeof cardinal === "string") {
    const facing = ["south", "west", "north", "east"].indexOf(cardinal);
    if (facing >= 0) return facing;
  }
  if (stairs || states.weirdo_direction !== undefined)
    return [3, 1, 0, 2][numberState(states, "weirdo_direction") & 3]!;
  return numberState(states, "direction") & 3;
}

function rotate(bounds: ModelBounds, turns: number): ModelBounds {
  let [x0, y0, z0, x1, y1, z1] = bounds;
  for (let turn = 0; turn < turns; turn++) [x0, z0, x1, z1] = [16 - z1, x0, 16 - z0, x1];
  return [x0, y0, z0, x1, y1, z1];
}

function oriented(parts: readonly ModelPart[], facing: number): readonly ModelPart[] {
  return facing === 0 ? parts : parts.map((p) => ({ ...p, bounds: rotate(p.bounds, facing) }));
}

function connected(model: BlockModel, neighbors: ModelNeighbors, index: number): boolean {
  const explicit = model.states[`minecraft:connection_${CONNECTIONS[index]}`];
  if (explicit !== undefined) return isSet(explicit);
  const [dx, dz] = DIRECTIONS[index]!;
  const neighbor = neighbors(dx, 0, dz);
  if (neighbor.opaque) return true;
  const family = neighbor.model?.family;
  if (model.family === "pane") return family === "pane" || neighbor.glass === true;
  if (family === "gate") {
    const acrossX = (modelFacing(neighbor.model!.states) & 1) === 0;
    return index < 2 ? acrossX : !acrossX;
  }
  if (model.family === "wall") return family === "wall";
  return (
    family === "fence" &&
    model.block.includes("nether_brick") === neighbor.model!.block.includes("nether_brick")
  );
}

/** Produces small, shared cuboid models; only connections depend on neighboring blocks. */
export function blockModelParts(
  model: BlockModel,
  neighbors: ModelNeighbors = EMPTY_NEIGHBORS,
): readonly ModelPart[] {
  const { states: s, family } = model;
  const facing = modelFacing(s, family === "stairs");
  switch (family) {
    case "stairs":
      return stairParts(model, neighbors);
    case "door": {
      const upper = isSet(s.upper_block_bit);
      const lowerModel = upper ? neighbors(0, -1, 0).model : model;
      const upperModel = upper ? model : neighbors(0, 1, 0).model;
      const lower = lowerModel?.family === "door" ? lowerModel.states : s;
      const hinge =
        upperModel?.family === "door" ? upperModel.states.door_hinge_bit : s.door_hinge_bit;
      const turns = (modelFacing(lower) + (isSet(lower.open_bit) ? (isSet(hinge) ? 1 : 3) : 0)) & 3;
      return oriented([part([0, 0, 0, 16, 16, 3])], turns);
    }
    case "trapdoor":
      return isSet(s.open_bit)
        ? oriented([part([0, 0, 13, 16, 16, 16])], facing)
        : [part(isSet(s.upside_down_bit) ? [0, 13, 0, 16, 16, 16] : [0, 0, 0, 16, 3, 16])];
    case "fence": {
      const parts: ModelPart[] = [part([6, 0, 6, 10, 16, 10])];
      for (let index = 0; index < 4; index++)
        if (connected(model, neighbors, index)) {
          for (const low of [6, 12]) {
            const bounds: ModelBounds = [7, low, 8, 9, low + 3, 16];
            parts.push(part(rotate(bounds, [3, 1, 0, 2][index]!)));
          }
        }
      return parts;
    }
    case "gate": {
      const parts: ModelPart[] = [part([0, 5, 7, 2, 16, 9]), part([14, 5, 7, 16, 16, 9])];
      if (isSet(s.open_bit)) {
        parts.push(
          part([0, 6, 9, 2, 9, 16]),
          part([14, 6, 9, 16, 9, 16]),
          part([0, 12, 9, 2, 15, 16]),
          part([14, 12, 9, 16, 15, 16]),
        );
      } else {
        parts.push(
          part([2, 6, 7, 14, 9, 9]),
          part([2, 12, 7, 14, 15, 9]),
          part([6, 9, 7, 10, 12, 9]),
        );
      }
      return oriented(parts, facing);
    }
    case "wall": {
      const parts: ModelPart[] = [];
      const links = CONNECTIONS.map((side, index) => {
        const value = s[`wall_connection_type_${side}`];
        return value === "none"
          ? 0
          : value === "tall"
            ? 16
            : value === "short"
              ? 14
              : connected(model, neighbors, index)
                ? 14
                : 0;
      });
      const straight =
        (links[0]! > 0 && links[1]! > 0 && !links[2] && !links[3]) ||
        (links[2]! > 0 && links[3]! > 0 && !links[0] && !links[1]);
      if (s.wall_post_bit === undefined ? !straight : isSet(s.wall_post_bit))
        parts.push(part([4, 0, 4, 12, 16, 12]));
      for (let index = 0; index < 4; index++)
        if (links[index]) {
          parts.push(part(rotate([5, 0, 8, 11, links[index]!, 16], [3, 1, 0, 2][index]!)));
        }
      return parts;
    }
    case "pane": {
      const parts: ModelPart[] = [part([7, 0, 7, 9, 16, 9])];
      for (let index = 0; index < 4; index++)
        if (connected(model, neighbors, index)) {
          parts.push(part(rotate([7, 0, 8, 9, 16, 16], [3, 1, 0, 2][index]!)));
        }
      return parts;
    }
    case "scaffolding": {
      const parts: ModelPart[] = [];
      for (const x of [0, 14])
        for (const z of [0, 14]) parts.push(part([x, 0, z, x + 2, 16, z + 2]));
      parts.push(
        part([0, 14, 0, 16, 16, 2]),
        part([0, 14, 14, 16, 16, 16]),
        part([0, 14, 2, 2, 16, 14]),
        part([14, 14, 2, 16, 16, 14]),
      );
      for (const x of [4, 8, 12]) parts.push(part([x, 14, 2, x + 1, 16, 14]));
      if (neighbors(0, -1, 0).model?.family !== "scaffolding" && numberState(s, "stability") > 0) {
        parts.push(part([0, 0, 0, 16, 2, 2]), part([0, 0, 14, 16, 2, 16]));
      }
      return parts;
    }
    case "bed": {
      const head = isSet(s.head_piece_bit);
      if (model.block === "straw_bed") {
        // Non-zero-volume cubes from the ZIP's straw_bed_{head,foot}.geo.json.
        // Flat, rotated fringe polygons remain outside the cuboid renderer.
        return oriented(
          head
            ? [part([0, 0, 0, 16, 4, 8]), part([0, 0, 8, 16, 5, 16])]
            : [part([0, 0, 0, 16, 4, 16])],
          facing,
        );
      }
      const wood = 0xa2834f;
      const parts = [part([0, 3, 0, 16, 6, 16], wood), part([0, 6, 0, 16, 9, 16])];
      const z = head ? 13 : 0;
      for (const x of [0, 13]) parts.push(part([x, 0, z, x + 3, 3, z + 3], wood));
      if (head) {
        // A texture-colored pillow on the existing mattress top, without increasing bed height.
        parts[1] = part([0, 6, 0, 16, 9, 12]);
        parts.push({ ...part([0, 6, 12, 16, 9, 16], 0xe8e7e2), textured: true });
      }
      return oriented(parts, facing);
    }
    case "chorus": {
      const parts: ModelPart[] = [part([3, 3, 3, 13, 13, 13])];
      const sides = [...CONNECTIONS, "up", "down"];
      const offsets = [...DIRECTIONS.map(([x, z]) => [x, 0, z]), [0, 1, 0], [0, -1, 0]];
      for (let index = 0; index < 6; index++) {
        const explicit = s[`minecraft:connection_${sides[index]}`];
        const [dx, dy, dz] = offsets[index]!;
        const n = neighbors(dx!, dy!, dz!);
        const link =
          explicit === undefined
            ? n.model?.family === "chorus" ||
              n.model?.family === "chorus-flower" ||
              (index === 5 && n.opaque)
            : isSet(explicit);
        if (!link) continue;
        const bounds: ModelBounds =
          index < 4
            ? rotate([4, 4, 8, 12, 12, 16], [3, 1, 0, 2][index]!)
            : index === 4
              ? [4, 8, 4, 12, 16, 12]
              : [4, 0, 4, 12, 8, 12];
        parts.push(part(bounds));
      }
      return parts;
    }
    case "chorus-flower":
      return [part([2, 2, 2, 14, 14, 14]), part([4, 0, 4, 12, 2, 12])];
    case "lantern": {
      const hanging = isSet(s.hanging);
      return hanging
        ? [
            sheetPart([5, 1, 5, 11, 8, 11], LANTERN_BODY),
            sheetPart([6, 8, 6, 10, 10, 10], LANTERN_CAP),
            sheetPart([7, 10, 7, 9, 16, 9], LANTERN_CHAIN),
          ]
        : [
            sheetPart([5, 0, 5, 11, 7, 11], LANTERN_BODY),
            sheetPart([6, 7, 6, 10, 9, 10], LANTERN_CAP),
          ];
    }
    case "pot":
      // The walls read the sheet where they stand; the floor reads the clay of the sides.
      return [
        sheetPart([5, 0, 5, 11, 1, 11], POT_FLOOR),
        part([5, 1, 5, 6, 6, 11]),
        part([10, 1, 5, 11, 6, 11]),
        part([6, 1, 5, 10, 6, 6]),
        part([6, 1, 10, 10, 6, 11]),
      ];
    case "chain": {
      const axis = s.pillar_axis === "x" ? "x" : s.pillar_axis === "z" ? "z" : "y";
      return [sheetPart(ROD_BOUNDS[axis], { axis, side: [0, 0] })];
    }
    case "rod":
    case "lightning-rod": {
      // Facing 0 down, 1 up, 2 north, 3 south, 4 west, 5 east: odd ones point to a positive end.
      const facing = numberState(s, "facing_direction", 1);
      const axis = (["y", "y", "z", "z", "x", "x"] as const)[facing] ?? "y";
      const positive = facing % 2 === 1;
      // The sheet's rod column runs from the rod's positive end. It is shorter than a block: the
      // texels past it fall where the base or the tip covers the rod, or where it meets its block.
      // Only standing and hanging rods get their base or tip: the box catalog has room for few.
      if (family === "rod")
        return [
          sheetPart(ROD_BOUNDS[axis], { axis, side: [0, positive ? 0 : 15], top: [2, 0] }),
          ...(axis === "y"
            ? [sheetPart(positive ? [6, 0, 6, 10, 1, 10] : [6, 15, 6, 10, 16, 10], END_ROD_BASE)]
            : []),
        ];
      return [
        sheetPart(ROD_BOUNDS[axis], { axis, side: [0, positive ? 0 : 4], top: [0, 0] }),
        ...(axis === "y"
          ? [sheetPart(positive ? [6, 12, 6, 10, 16, 10] : [6, 0, 6, 10, 4, 10], LIGHTNING_ROD_TIP)]
          : []),
      ];
    }
    case "portal":
      // A Nether portal's sheet, four sixteenths thick, across the axis it spans.
      return [part(s.portal_axis === "z" ? [6, 0, 0, 10, 16, 16] : [0, 0, 6, 16, 16, 10])];
    case "wall-torch": {
      // Upright against the wall the state names; the game tilts it, which boxes cannot.
      const side = s.torch_facing_direction;
      return [
        sheetPart(
          side === "north"
            ? [7, 5, 0, 9, 16, 2]
            : side === "south"
              ? [7, 5, 14, 9, 16, 16]
              : side === "west"
                ? [0, 5, 7, 2, 16, 9]
                : [14, 5, 7, 16, 16, 9],
          { side: [7, 6], top: [7, 6], bottom: [7, 13] },
        ),
      ];
    }
    case "shelf-mushroom": {
      // A shelf jutting from the log behind it toward `minecraft:cardinal_direction`.
      const side = s["minecraft:cardinal_direction"];
      return [
        part(
          side === "west"
            ? [8, 6, 2, 16, 8, 14]
            : side === "south"
              ? [2, 6, 0, 14, 8, 8]
              : side === "north"
                ? [2, 6, 8, 14, 8, 16]
                : [0, 6, 2, 8, 8, 14],
        ),
      ];
    }
    case "ladder": {
      const parts: ModelPart[] = [part([2, 0, 0, 4, 16, 2]), part([12, 0, 0, 14, 16, 2])];
      for (const y of [1, 4, 7, 10, 13]) parts.push(part([4, y, 0, 12, y + 1, 2]));
      return oriented(parts, [0, 0, 0, 2, 3, 1][numberState(s, "facing_direction", 2)]!);
    }
    case "candle": {
      const count = Math.min(4, Math.max(1, numberState(s, "candles") + 1));
      const positions =
        count === 1
          ? [[7, 7]]
          : [
              [5, 5],
              [9, 8],
              [5, 10],
              [10, 4],
            ];
      return positions
        .slice(0, count)
        .map(([x, z], index) =>
          sheetPart([x!, 0, z!, x! + 2, 4 + (index % 3) * 2, z! + 2], CANDLE),
        );
    }
    case "cake":
      return [part([Math.min(13, 1 + numberState(s, "bite_counter") * 2), 0, 1, 15, 8, 15])];
    case "cauldron":
      return [
        part([0, 0, 0, 16, 4, 16]),
        part([0, 4, 0, 2, 16, 16]),
        part([14, 4, 0, 16, 16, 16]),
        part([2, 4, 0, 14, 16, 2]),
        part([2, 4, 14, 14, 16, 16]),
      ];
    case "anvil": {
      // The top runs across the way the anvil faces; its texture runs along the top.
      const along = (facing & 1) === 1;
      return ANVIL_PARTS.map((bounds, index) =>
        index < 3
          ? // Only the top shows the top texture, which is clear beyond its face.
            { bounds: along ? bounds : rotate(bounds, 1), faces: ANVIL_BASE_FACES }
          : along
            ? part(bounds)
            : sheetPart(rotate(bounds, 1), { axis: "x", side: [3, 0], top: [3, 0] }),
      );
    }
    case "grindstone":
      return grindstoneParts(s, facing);
    case "stonecutter": {
      // The blade lies across the way the stonecutter faces; `facing_direction` in older worlds.
      const old = numberState(s, "facing_direction", -1);
      const across = old >= 2 ? old >= 4 : (facing & 1) === 1;
      return [
        { bounds: [0, 0, 0, 16, 9, 16], faces: STONECUTTER_BASE_FACES },
        {
          bounds: across ? [8, 9, 1, 8, 16, 15] : [1, 9, 8, 15, 16, 8],
          faces: ALL_FACES(Face.PositiveX),
          sheet: { side: [1, 9] },
        },
      ];
    }
    case "campfire":
      return campfireParts(s, facing);
    case "lectern":
      // Base, post, and the desk in two steps sloping down to its front.
      return oriented(
        [
          part([0, 0, 0, 16, 2, 16]),
          part([4, 2, 4, 12, 12, 12]),
          part([0, 12, 0, 16, 15, 8]),
          part([0, 12, 8, 16, 14, 16]),
        ],
        facing,
      );
    case "composter": {
      // The compost rises with the fill level; it reads the bottom texture, as the top one is
      // open in its middle.
      const level = Math.min(7, numberState(s, "composter_fill_level"));
      return [
        { bounds: [2, 0, 2, 14, 2 + level * 2, 14], faces: COMPOST_FACES },
        part([0, 0, 0, 2, 16, 16]),
        part([14, 0, 0, 16, 16, 16]),
        part([2, 0, 0, 14, 16, 2]),
        part([2, 0, 14, 14, 16, 16]),
      ];
    }
    case "low-box":
      return [part([0, 0, 0, 16, model.block === "enchanting_table" ? 12 : 13, 16])];
    case "hopper":
      return [
        part([0, 10, 0, 2, 16, 16]),
        part([14, 10, 0, 16, 16, 16]),
        part([2, 10, 0, 14, 16, 2]),
        part([2, 10, 14, 14, 16, 16]),
        part([4, 4, 4, 12, 10, 12]),
        part([6, 0, 6, 10, 4, 10]),
      ];
  }
}

/**
 * A grindstone stands on the floor, hangs from the ceiling, or sits against the wall behind it.
 * Its legs read the block's bottom texture, its pivots the north one, and its wheel the east
 * one on its two flat sides and the top one around its rim.
 */
function grindstoneParts(s: LittleEndianNbtCompoundValue, facing: number): readonly ModelPart[] {
  const attachment = s.attachment;
  const place = (bounds: ModelBounds): ModelBounds => {
    const [x0, y0, z0, x1, y1, z1] = bounds;
    const placed: ModelBounds =
      attachment === "hanging"
        ? [x0, 16 - y1, z0, x1, 16 - y0, z1]
        : attachment === "side" || attachment === "multiple"
          ? [x0, 16 - z1, y0, x1, 16 - z0, y1]
          : bounds;
    return rotate(placed, facing);
  };
  const axle = (facing & 1) === 0 ? 0 : 2;
  const wheelFaces = [0, 1, 2, 3, 4, 5].map((face) =>
    face >> 1 === axle ? Face.PositiveX : Face.PositiveY,
  );
  return [
    ...GRINDSTONE_LEGS.map((bounds) => ({
      bounds: place(bounds),
      faces: ALL_FACES(Face.NegativeY),
    })),
    // The pivot, rim and side pictures sit in the top left corner of their textures.
    ...GRINDSTONE_PIVOTS.map((bounds) => ({
      bounds: place(bounds),
      faces: ALL_FACES(Face.NegativeZ),
      sheet: CORNER,
    })),
    {
      bounds: place(GRINDSTONE_WHEEL),
      faces: wheelFaces,
      // Along the axis the wheel rolls, so the 8 by 12 rim runs down its picture.
      sheet: { ...CORNER, axis: axle === 0 ? "z" : "x" },
    },
  ];
}

const ALL_FACES = (face: number): readonly number[] => [face, face, face, face, face, face];
const COMPOST_FACES: readonly number[] = [
  Face.PositiveX,
  Face.NegativeX,
  Face.NegativeY,
  Face.NegativeY,
  Face.PositiveZ,
  Face.NegativeZ,
];
/** A stonecutter's base: its sides all read the south face, as the east and west hold the saw. */
const STONECUTTER_BASE_FACES: readonly number[] = [
  Face.PositiveZ,
  Face.PositiveZ,
  Face.PositiveY,
  Face.NegativeY,
  Face.PositiveZ,
  Face.NegativeZ,
];

/**
 * A campfire: four logs read the bottom texture (bark along its top rows, the 4 by 4 log end
 * below), the bed of embers the side texture, and two crossed planes the flames on top.
 * An extinguished one has cold embers and no flames.
 */
function campfireParts(s: LittleEndianNbtCompoundValue, facing: number): readonly ModelPart[] {
  const lit = !isSet(s.extinguished);
  const turn = facing & 1;
  const log = (bounds: ModelBounds, axis: "x" | "z"): ModelPart => ({
    bounds: rotate(bounds, turn),
    faces: ALL_FACES(Face.NegativeY),
    sheet: {
      axis: turn === 1 ? (axis === "x" ? "z" : "x") : axis,
      side: [0, 0],
      top: [0, 4],
      across: true,
    },
  });
  const parts: ModelPart[] = [
    log([1, 0, 0, 5, 4, 16], "z"),
    log([11, 0, 0, 15, 4, 16], "z"),
    log([0, 3, 11, 16, 7, 15], "x"),
    log([0, 3, 1, 16, 7, 5], "x"),
    {
      bounds: rotate([5, 0, 0, 11, 1, 16], turn),
      faces: ALL_FACES(lit ? Face.PositiveZ : Face.NegativeY),
      sheet: { axis: turn === 1 ? "x" : "z", side: [0, 8], across: true },
    },
  ];
  if (lit)
    parts.push(
      { bounds: [0, 0, 8, 16, 16, 8], faces: ALL_FACES(Face.PositiveY) },
      { bounds: [8, 0, 0, 8, 16, 16], faces: ALL_FACES(Face.PositiveY) },
    );
  return parts;
}
const CORNER: PartSheet = { side: [0, 0], top: [0, 0] };
/** Every face of a part from the block's side and bottom textures, as below an anvil's top. */
const ANVIL_BASE_FACES: readonly number[] = [
  Face.PositiveX,
  Face.NegativeX,
  Face.NegativeY,
  Face.NegativeY,
  Face.PositiveZ,
  Face.NegativeZ,
];

function stairParts(model: BlockModel, neighbors: ModelNeighbors): readonly ModelPart[] {
  const { states: s } = model;
  const upside = isSet(s.upside_down_bit);
  const low = upside ? 0 : 8;
  let corner = s["minecraft:corner"];
  const facing = modelFacing(s, true);
  // Older palettes omit the derived corner state. Reconstruct it from same-half stairs.
  if (corner === undefined) {
    const [dx, dz] = [
      [0, 1],
      [-1, 0],
      [0, -1],
      [1, 0],
    ][facing]!;
    const inFront = neighbors(dx!, 0, dz!).model;
    const behind = neighbors(-dx!, 0, -dz!).model;
    for (const [neighbor, outer] of [
      [inFront, true],
      [behind, false],
    ] as const) {
      if (neighbor?.family !== "stairs" || isSet(neighbor.states.upside_down_bit) !== upside)
        continue;
      const turn = (modelFacing(neighbor.states, true) - facing + 4) & 3;
      if (turn !== 1 && turn !== 3) continue;
      const [nx, nz] = [
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 0],
      ][modelFacing(neighbor.states, true)]!;
      const beside = neighbors(nx! * (outer ? -1 : 1), 0, nz! * (outer ? -1 : 1)).model;
      if (
        beside?.family === "stairs" &&
        modelFacing(beside.states, true) === facing &&
        isSet(beside.states.upside_down_bit) === upside
      )
        continue;
      corner = `${outer ? "outer" : "inner"}_${turn === 1 ? "right" : "left"}`;
      break;
    }
  }
  const parts: ModelPart[] = [part(upside ? [0, 8, 0, 16, 16, 16] : [0, 0, 0, 16, 8, 16])];
  const left = corner === "outer_left" || corner === "inner_left";
  if (corner === "outer_left" || corner === "outer_right")
    parts.push(part([left ? 8 : 0, low, 8, left ? 16 : 8, low + 8, 16]));
  else {
    parts.push(part([0, low, 8, 16, low + 8, 16]));
    if (corner === "inner_left" || corner === "inner_right")
      parts.push(part([left ? 8 : 0, low, 0, left ? 16 : 8, low + 8, 8]));
  }
  return oriented(parts, facing);
}

/** Deterministic finite catalog used by the offline bounds-table generator and exhaustive tests. */
export function modelCatalog(): readonly BlockModel[] {
  const samples: BlockModel[] = [];
  const add = (block: string, states: LittleEndianNbtCompoundValue = {}) => {
    const model = resolveBlockModel(block, { ...states });
    if (model !== undefined) samples.push(model);
  };
  for (let direction = 0; direction < 4; direction++) {
    for (const upside_down_bit of [0, 1])
      for (const corner of ["none", "inner_left", "inner_right", "outer_left", "outer_right"])
        add("oak_stairs", {
          weirdo_direction: direction,
          upside_down_bit,
          "minecraft:corner": corner,
        });
    for (const open_bit of [0, 1]) {
      for (const door_hinge_bit of [0, 1])
        add("wooden_door", { direction, open_bit, door_hinge_bit });
      for (const upside_down_bit of [0, 1])
        add("trapdoor", { direction, open_bit, upside_down_bit });
      add("oak_fence_gate", { direction, open_bit });
    }
    for (const head_piece_bit of [0, 1]) {
      add("bed", { direction, head_piece_bit });
      add("straw_bed", { direction, head_piece_bit });
    }
  }
  for (const block of ["oak_fence", "cobblestone_wall", "glass_pane", "chorus_plant"]) {
    const s: Record<string, string | number> = {};
    for (const side of [...CONNECTIONS, "up", "down"]) s[`minecraft:connection_${side}`] = 1;
    for (const side of CONNECTIONS) s[`wall_connection_type_${side}`] = "tall";
    add(block, s);
    if (block.endsWith("wall")) {
      for (const side of CONNECTIONS) s[`wall_connection_type_${side}`] = "short";
      add(block, { ...s });
    }
  }
  for (const block of ["scaffolding", "chorus_flower", "flower_pot", "cauldron", "hopper"])
    add(block, { stability: 1 });
  for (const hanging of [0, 1]) add("lantern", { hanging });
  for (let facing_direction = 0; facing_direction < 6; facing_direction++) {
    add("end_rod", { facing_direction });
    add("lightning_rod", { facing_direction });
    if (facing_direction >= 2) add("ladder", { facing_direction });
  }
  for (const pillar_axis of ["x", "y", "z"]) add("chain", { pillar_axis });
  for (const portal_axis of ["x", "z"]) add("portal", { portal_axis });
  for (const side of ["north", "south", "east", "west"]) {
    add("shelf_mushroom", { "minecraft:cardinal_direction": side });
    add("torch", { torch_facing_direction: side });
  }
  for (let candles = 0; candles < 4; candles++) add("candle", { candles });
  for (let bite_counter = 0; bite_counter < 7; bite_counter++) add("cake", { bite_counter });
  add("enchanting_table");
  add("end_portal_frame");
  for (let composter_fill_level = 0; composter_fill_level <= 8; composter_fill_level++)
    add("composter", { composter_fill_level });
  for (let direction = 0; direction < 4; direction++) add("lectern", { direction });
  for (const side of ["north", "east"]) {
    add("stonecutter_block", { "minecraft:cardinal_direction": side });
    for (const extinguished of [0, 1])
      add("campfire", { "minecraft:cardinal_direction": side, extinguished });
  }
  for (let direction = 0; direction < 4; direction++) {
    add("anvil", { direction });
    for (const attachment of ["standing", "hanging", "side"])
      add("grindstone", { direction, attachment });
  }
  return samples;
}
