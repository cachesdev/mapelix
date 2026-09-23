import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";

import {
  resolveBlockAppearance,
  type BiomeTint,
  type BlockAppearance,
  type BlockShape,
  type SurfaceMaterial,
} from "../blocks/block-appearance.js";
import { Face, PlantSprite, QuadMaterial } from "../format.js";

/** Shape codes stored per palette id. */
export const Shape = {
  Empty: 0,
  Cube: 1,
  Box: 2,
  Water: 3,
  Glass: 4,
  Plant: 5,
} as const;

/** What a block becomes in the voxel levels, which draw every block as a cube. */
export const VoxelKind = {
  Air: 0,
  Solid: 1,
  Foliage: 2,
  Emissive: 3,
  Water: 4,
  Glass: 5,
  /** A thin layer, such as snow or a carpet, that colors the top of the block below. */
  Layer: 6,
} as const;

/** Boxes that fill at least this share of their block become whole voxels. */
const MIN_VOXEL_VOLUME = 1 / 16;

/** Tint codes stored per face, matching the columns of `BiomeTints`. */
export const TintCode = {
  None: 0,
  Ground: 1,
  Grass: 2,
  Foliage: 3,
  Water: 4,
} as const;

const TINT_CODES: Readonly<Record<BiomeTint, number>> = {
  none: TintCode.None,
  ground: TintCode.Ground,
  grass: TintCode.Grass,
  foliage: TintCode.Foliage,
  water: TintCode.Water,
};

/** Palette ids are 15 bits. The top bit of a volume cell marks waterlogged blocks. */
export const WATERLOGGED = 0x8000;
export const PALETTE_ID_MASK = 0x7fff;

/** Plant heights in sixteenths, so short flowers do not look like saplings. */
const PLANT_HEIGHTS: Readonly<Record<PlantSprite, number>> = {
  [PlantSprite.Grass]: 13,
  [PlantSprite.Flower]: 12,
  [PlantSprite.Bush]: 14,
  [PlantSprite.Crop]: 14,
  [PlantSprite.Stalk]: 16,
  [PlantSprite.Mushroom]: 8,
};

/** State keys that change a block's appearance. Other states would only split cache entries. */
const APPEARANCE_STATES = [
  "minecraft:vertical_half",
  "top_slot_bit",
  "height",
  "upside_down_bit",
  "pillar_axis",
  "color",
  "old_log_type",
  "new_log_type",
  "old_leaf_type",
  "new_leaf_type",
  "wood_type",
  "double_plant_type",
  "tall_grass_type",
  "flower_type",
  "stone_type",
  "sand_type",
  "dirt_type",
];

/**
 * Flat, id-indexed tables of block appearances. Id 0 is air. The mesher's inner
 * loops read only these typed arrays, never the appearance objects.
 */
export class BlockPalette {
  shape = new Uint8Array(256);
  material = new Uint8Array(256);
  boxSize = new Uint8Array(256);
  boxInset = new Uint8Array(256);
  boxTop = new Uint8Array(256);
  sprite = new Uint8Array(256);
  /** 1 when the block's sides are soil under a strip of its top color. */
  covered = new Uint8Array(256);
  /** `VoxelKind` of each block in the coarse voxel levels. */
  voxel = new Uint8Array(256);
  /** Face colors, six per id in `Face` order. */
  colors = new Uint32Array(256 * 6);
  /** Face tint codes, six per id in `Face` order. */
  tints = new Uint8Array(256 * 6);

  private readonly ids = new Map<string, number>([["minecraft:air", 0]]);
  private size = 1;

  /** Returns the palette id for a block, registering it on first use. */
  idFor(name: string, states: LittleEndianNbtCompoundValue | undefined): number {
    const key = appearanceKey(name, states);
    const known = this.ids.get(key);
    if (known !== undefined) return known;

    const id = this.size;
    if (id > PALETTE_ID_MASK) throw new Error("Scene block palette is full");
    this.size += 1;
    this.ensureCapacity(this.size);
    this.write(id, resolveBlockAppearance(name, states ?? {}));
    this.ids.set(key, id);
    return id;
  }

  isOpaque(id: number): boolean {
    return this.shape[id] === Shape.Cube;
  }

  private write(id: number, appearance: BlockAppearance): void {
    const { shape } = appearance;
    switch (shape.kind) {
      case "empty":
        this.shape[id] = Shape.Empty;
        break;
      case "cube":
        this.shape[id] = Shape.Cube;
        this.material[id] = shape.material;
        this.setBox(id, 16, 0, false);
        break;
      case "box":
        this.shape[id] = Shape.Box;
        this.material[id] = shape.material;
        this.setBox(id, shape.box.size, shape.box.inset, shape.box.anchoredTop);
        break;
      case "water":
        this.shape[id] = Shape.Water;
        this.material[id] = QuadMaterial.Water;
        this.setBox(id, 16, 0, false);
        break;
      case "glass":
        this.shape[id] = Shape.Glass;
        this.material[id] = QuadMaterial.Glass;
        this.setBox(id, 16, 0, false);
        break;
      case "plant":
        this.shape[id] = Shape.Plant;
        this.material[id] = QuadMaterial.Plant;
        this.sprite[id] = shape.sprite;
        this.setBox(id, PLANT_HEIGHTS[shape.sprite], 2, false);
        break;
      default: {
        const unhandled: never = shape;
        throw new Error(`Unhandled block shape ${JSON.stringify(unhandled)}`);
      }
    }

    this.voxel[id] = voxelKindOf(shape);
    this.covered[id] = appearance.coveredSides ? 1 : 0;
    const tint = TINT_CODES[appearance.tint];
    for (let face = 0; face < 6; face += 1) {
      const end = faceAxis(face) === appearance.axis;
      const color = !end
        ? appearance.side
        : face === Face.NegativeX || face === Face.NegativeY || face === Face.NegativeZ
          ? appearance.bottom
          : appearance.top;
      this.colors[id * 6 + face] = color;
      const tinted = !appearance.tintTopOnly || face === Face.PositiveY;
      this.tints[id * 6 + face] = tinted ? tint : TintCode.None;
    }
  }

  private setBox(id: number, size: number, inset: number, anchoredTop: boolean): void {
    this.boxSize[id] = size;
    this.boxInset[id] = inset;
    this.boxTop[id] = anchoredTop ? 1 : 0;
  }

  private ensureCapacity(size: number): void {
    if (size <= this.shape.length) return;
    const capacity = this.shape.length * 2;
    this.shape = grow(this.shape, capacity);
    this.material = grow(this.material, capacity);
    this.boxSize = grow(this.boxSize, capacity);
    this.boxInset = grow(this.boxInset, capacity);
    this.boxTop = grow(this.boxTop, capacity);
    this.sprite = grow(this.sprite, capacity);
    this.covered = grow(this.covered, capacity);
    this.voxel = grow(this.voxel, capacity);
    this.tints = grow(this.tints, capacity * 6);
    const colors = new Uint32Array(capacity * 6);
    colors.set(this.colors);
    this.colors = colors;
  }
}

function voxelKindOf(shape: BlockShape): number {
  switch (shape.kind) {
    case "cube":
      return solidKind(shape.material);
    case "box": {
      const { size, inset } = shape.box;
      if (inset === 0 && size < 8) return VoxelKind.Layer;
      // Torches and lanterns stay lit, so villages still glow far away at night.
      if (shape.material === QuadMaterial.Emissive) return VoxelKind.Emissive;
      const width = 16 - 2 * inset;
      return (size * width * width) / 16 ** 3 >= MIN_VOXEL_VOLUME
        ? solidKind(shape.material)
        : VoxelKind.Air;
    }
    case "water":
      return VoxelKind.Water;
    case "glass":
      return VoxelKind.Glass;
    default:
      return VoxelKind.Air;
  }
}

function solidKind(material: SurfaceMaterial): number {
  if (material === QuadMaterial.Foliage) return VoxelKind.Foliage;
  return material === QuadMaterial.Emissive ? VoxelKind.Emissive : VoxelKind.Solid;
}

function faceAxis(face: number): "x" | "y" | "z" {
  if (face === Face.PositiveX || face === Face.NegativeX) return "x";
  if (face === Face.PositiveY || face === Face.NegativeY) return "y";
  return "z";
}

function appearanceKey(name: string, states: LittleEndianNbtCompoundValue | undefined): string {
  if (states === undefined) return name;
  let key = name;
  for (const state of APPEARANCE_STATES) {
    const value = states[state];
    if (typeof value === "string" || typeof value === "number") key += `|${state}=${value}`;
  }
  return key;
}

function grow(array: Uint8Array, capacity: number): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(capacity);
  grown.set(array);
  return grown;
}
