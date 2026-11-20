import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";
import { canonicalBlockName } from "@mapelix/core/appearance";

import type { BlockAppearance } from "../blocks/block-appearance.js";
import { Face } from "../format.js";
import type { BlockFace, BlockTextureNames, TerrainEntry } from "./resource-pack.js";

/** What a texture lookup needs from a pack stack. */
export interface TextureNames {
  blockTextures(block: string): BlockTextureNames | undefined;
  terrainEntry(name: string): TerrainEntry | undefined;
}

/**
 * One face's texture. The image path has no extension. `rotation` turns the texture by quarter
 * turns on the face, whose texture axes are fixed per face direction (see `faceTextureAxes`).
 */
export interface FaceTexture {
  readonly path: string;
  readonly rotation: 0 | 1 | 2 | 3;
  /** The texture is gray and takes the block's biome color, as grass tops and leaves do. */
  readonly tinted: boolean;
}

/** The textures of a block's six faces in `Face` order, and of its crossed plant quads. */
export interface BlockTextures {
  readonly faces: readonly (FaceTexture | undefined)[];
  readonly cross: FaceTexture | undefined;
}

/** Block names whose `blocks.json` entry has another name. */
const ALIASES: Readonly<Record<string, string>> = {
  grass_block: "grass",
  dirt_path: "grass_path",
  lily_pad: "waterlily",
  iron_chain: "chain",
};

/** States that turn a block's textures, beyond those that already change its appearance. */
export const TEXTURE_STATES = [
  "facing_direction",
  "growth",
  "age",
  "huge_mushroom_bits",
  "hanging",
  "rail_direction",
  "rail_data_bit",
] as const;

/** `blocks.json` face of each mesh face before any turn: east +X, south +Z, up +Y. */
const FACE_NAMES: readonly BlockFace[] = ["east", "west", "up", "down", "south", "north"];

/** Horizontal faces in clockwise order seen from above, starting at the front (south). */
const RING: readonly BlockFace[] = ["south", "west", "north", "east"];

/**
 * The two world axes along a face's texture `u` (left to right) and `v` (bottom to top).
 * The shader uses the same table, so a texture repeats seamlessly over a merged quad.
 */
export function faceTextureAxes(face: number): readonly ["x" | "y" | "z", "x" | "y" | "z"] {
  if (face === Face.PositiveX || face === Face.NegativeX) return ["z", "y"];
  if (face === Face.PositiveY || face === Face.NegativeY) return ["x", "z"];
  return ["x", "y"];
}

/** `facing_direction` values: down, up, then the four horizontal directions. */
const FACING_DIRECTIONS = [undefined, undefined, "north", "south", "west", "east"] as const;

/** The horizontal direction a block's front faces, from its states. */
function facing(states: LittleEndianNbtCompoundValue): BlockFace | undefined {
  const cardinal = states["minecraft:cardinal_direction"];
  if (typeof cardinal === "string" && (RING as readonly string[]).includes(cardinal)) {
    return cardinal as BlockFace;
  }
  const facingDirection = states["facing_direction"];
  if (typeof facingDirection === "number") return FACING_DIRECTIONS[facingDirection];
  // The legacy `direction` counts quarter turns from south, like `RING`.
  const direction = states["direction"];
  return typeof direction === "number" ? RING[direction] : undefined;
}

/**
 * The legacy variant of a multi-texture terrain entry: the cap, stem or inside of each face of
 * a huge mushroom block, growth stages, or the first.
 */
function variantIndex(states: LittleEndianNbtCompoundValue, count: number): number {
  if (count <= 1) return 0;
  const bits = states.huge_mushroom_bits;
  if (typeof bits === "number" && Number.isSafeInteger(bits) && bits >= 0)
    return Math.min(count - 1, bits);
  for (const [state, stages] of [
    ["growth", 8],
    ["age", 4],
  ] as const) {
    const value = states[state];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return Math.min(count - 1, Math.floor((value * count) / stages));
    }
  }
  return 0;
}

/**
 * Finds the textures of a block's faces in a pack stack, following its axis (logs, pillars) and
 * front direction (furnaces, pumpkins). Faces without a texture stay undefined and keep their
 * color; a block unknown to the stack returns undefined.
 */
/** Model families whose parts pick their faces of the block's textures (`ModelPart.faces`). */
const OWN_FACES: ReadonlySet<string> = new Set([
  "grindstone",
  "stonecutter",
  "campfire",
  "bell",
  "lectern",
]);

export function resolveBlockTextures(
  names: TextureNames,
  name: string,
  states: LittleEndianNbtCompoundValue,
  appearance: BlockAppearance,
): BlockTextures | undefined {
  // Pre-flattening names (`log` with `old_log_type`) map to modern ones first.
  const modern = canonicalBlockName(name, states);
  const entry =
    names.blockTextures(modern) ??
    names.blockTextures(ALIASES[modern] ?? modern) ??
    names.blockTextures(name.replace(/^minecraft:/, ""));
  if (entry === undefined) return undefined;

  const lookup = (blockFace: BlockFace): string | undefined => {
    const terrain = names.terrainEntry(entry[blockFace]);
    if (terrain === undefined) return undefined;
    return terrain.textures[variantIndex(states, terrain.textures.length)]?.path;
  };
  const front =
    appearance.shape.kind === "model" && OWN_FACES.has(appearance.shape.model.family)
      ? undefined
      : facing(states);
  const turn = front === undefined ? 0 : RING.indexOf(front);
  const tintedFace = (face: number): boolean =>
    appearance.tint !== "none" && (!appearance.tintTopOnly || face === Face.PositiveY);

  const lying = appearance.axis !== "y";
  const rail = railTop(modern.replace(/^minecraft:/, ""), states);
  // The pack draws pointed dripstone hanging; a standing one reads it upside down.
  const upsideDown =
    modern.replace(/^minecraft:/, "") === "pointed_dripstone" &&
    states.hanging !== 1 &&
    states.hanging !== true;
  const faces = FACE_NAMES.map((blockFace, face): FaceTexture | undefined => {
    // Along a pillar's axis the faces show its ends. Its other faces show its sides, turned
    // so that the grain runs along the axis.
    const axis = faceAxis(face);
    let source: BlockFace;
    if (lying) source = axis === appearance.axis ? (face % 2 === 0 ? "up" : "down") : "north";
    else if (axis === "y") source = blockFace;
    else source = RING[(RING.indexOf(blockFace) - turn + 4) % 4]!;
    const rotation = upsideDown
      ? 2
      : lying && axis !== appearance.axis && faceTextureAxes(face)[0] === appearance.axis
        ? 1
        : 0;
    if (rail !== undefined && face === Face.PositiveY) {
      const railPath = lookup(rail.source);
      return railPath === undefined
        ? undefined
        : { path: railPath, rotation: rail.rotation, tinted: false };
    }
    const path = lookup(source);
    return path === undefined ? undefined : { path, rotation, tinted: tintedFace(face) };
  });
  const crossPath = lookup("north") ?? lookup("up");
  return {
    faces,
    cross:
      crossPath === undefined
        ? undefined
        : { path: crossPath, rotation: 0, tinted: appearance.tint !== "none" },
  };
}

/**
 * The top of a rail. Plain rails keep their straight image under `down` and their curve under
 * `up`; powered, detector and activator rails keep their powered image under `up`. Straight
 * rails run north to south unturned, curves join south and east unturned.
 */
function railTop(
  block: string,
  states: LittleEndianNbtCompoundValue,
): { source: BlockFace; rotation: 0 | 1 | 2 | 3 } | undefined {
  if (!/(?:^|_)rail$/.test(block)) return undefined;
  const direction = typeof states.rail_direction === "number" ? states.rail_direction : 0;
  if (direction >= 6) return { source: "up", rotation: ((direction - 6) & 3) as 0 | 1 | 2 | 3 };
  // 1 runs east to west, 2 and 3 climb east and west, 4 and 5 north and south.
  const rotation = direction === 1 || direction === 2 || direction === 3 ? 1 : 0;
  const powered = block !== "rail" && states.rail_data_bit === 1;
  return { source: powered ? "up" : "down", rotation };
}

function faceAxis(face: number): "x" | "y" | "z" {
  if (face === Face.PositiveX || face === Face.NegativeX) return "x";
  if (face === Face.PositiveY || face === Face.NegativeY) return "y";
  return "z";
}
