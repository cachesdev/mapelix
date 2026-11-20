import type { LittleEndianNbtCompoundValue } from "@mapelix/prototype/bedrock";

import { BEDROCK_COLOR_STATES } from "../blocks/bedrock-colors.js";
import { LIGHT_STATES, blockEmission } from "../blocks/block-light.js";
import {
  resolveBlockAppearance,
  type BiomeTint,
  type BlockAppearance,
  type BlockShape,
  type SurfaceMaterial,
} from "../blocks/block-appearance.js";
import { Face, PlantSprite, QuadMaterial } from "../format.js";
import { MODEL_STATES, blockModelParts, type BlockModel } from "../blocks/block-models.js";
import { QUAD_CUTOUT, packQuadTexture } from "../textures/atlas-format.js";
import { sheetFaceWord, type PartSheet } from "../textures/sheet-faces.js";
import { BED_COLORS, bedTilePath, type BedTile } from "../textures/bed-tiles.js";
import { BANNER_TILE } from "../textures/banner-tile.js";
import {
  TEXTURE_STATES,
  resolveBlockTextures,
  type FaceTexture,
  type TextureNames,
} from "../textures/block-textures.js";
import type { BlockTextureNames, TerrainEntry } from "../textures/resource-pack.js";

/** What a palette needs to texture blocks: a `TextureIndex` of the atlas. */
export interface PaletteTextures {
  readonly fingerprint: string;
  readonly tiles: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, BlockTextureNames>>;
  readonly terrain: Readonly<Record<string, TerrainEntry>>;
  /** Atlas tiles with holes, such as leaves. */
  readonly cutout?: readonly number[];
}

/** Shape codes stored per palette id. */
export const Shape = {
  Empty: 0,
  Cube: 1,
  Box: 2,
  Water: 3,
  Glass: 4,
  Plant: 5,
  Model: 6,
  Lava: 7,
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
  Lava: 7,
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

/**
 * Blocks whose gray texture the game colors with a tint this engine keeps as the block's own
 * color, such as the dry foliage color of leaf litter: the texture takes that color.
 */
const SELF_TINTED: ReadonlySet<string> = new Set(["leaf_litter", "waterlily", "lily_pad"]);

/**
 * A torch's stick: its sides as the sheet holds them, its top and bottom from the stick. Models
 * drawn from a sheet of parts, such as lanterns, name their rectangles on each part instead
 * (`ModelPart.sheet`).
 */
const TORCH: PartSheet = { side: [7, 6], top: [7, 6], bottom: [7, 13] };
const TORCH_BLOCK = /(?:^|_)torch$/;

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
  ...MODEL_STATES,
  ...LIGHT_STATES,
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
const APPEARANCE_STATE_KEYS: ReadonlySet<string> = new Set(APPEARANCE_STATES);
const TEXTURED_STATE_KEYS: ReadonlySet<string> = new Set([...APPEARANCE_STATES, ...TEXTURE_STATES]);

/**
 * Flat, id-indexed tables of block appearances. Id 0 is air. The mesher's inner
 * loops read only these typed arrays, never the appearance objects. A textured palette also
 * holds each face's atlas texture word; it tells apart the states that turn textures, so its
 * ids differ from a plain palette's.
 */
export class BlockPalette {
  /** The atlas this palette textures blocks with, or undefined for a plain palette. */
  readonly textures: PaletteTextures | undefined;
  /** Texture words (`packQuadTexture`), six per id in `Face` order; 0 draws the color. */
  textureWords = new Uint32Array(0);
  /** Texture word of each id's crossed plant quads. */
  crossWords = new Uint32Array(0);
  /**
   * Blocks whose textures have holes: 1 for full cubes like leaves, which detailed meshes see
   * through, 2 for thin and shaped blocks like leaf litter, which textured meshes always see
   * through.
   */
  cutout = new Uint8Array(0);
  private readonly cutoutTiles: ReadonlySet<number> = new Set();
  /** Texture word of water surfaces and waterlogged cells. */
  readonly waterWord: number = 0;
  private readonly names: TextureNames | undefined;
  shape = new Uint8Array(256);
  /** Block emission, independent of the visual material and of the texture stack. */
  emission = new Uint8Array(256);
  material = new Uint8Array(256);
  boxSize = new Uint8Array(256);
  boxInset = new Uint8Array(256);
  boxTop = new Uint8Array(256);
  sprite = new Uint8Array(256);
  readonly models: Array<BlockModel | undefined> = [];
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

  constructor(textures?: PaletteTextures) {
    this.textures = textures;
    if (textures === undefined) return;
    const index = textures;
    this.names = {
      blockTextures: (block) => index.blocks[block],
      terrainEntry: (name) => index.terrain[name],
    };
    this.textureWords = new Uint32Array(256 * 6);
    this.crossWords = new Uint32Array(256);
    this.cutout = new Uint8Array(256);
    this.cutoutTiles = new Set(textures.cutout ?? []);
    const water = resolveBlockTextures(
      this.names,
      "minecraft:water",
      {},
      resolveBlockAppearance("minecraft:water", {}),
    );
    this.waterWord = this.textureWord(water?.faces[Face.PositiveY], true);
  }

  /** Returns the palette id for a block, registering it on first use. */
  idFor(name: string, states: LittleEndianNbtCompoundValue | undefined): number {
    const key = appearanceKey(
      name,
      states,
      this.textures === undefined ? APPEARANCE_STATE_KEYS : TEXTURED_STATE_KEYS,
    );
    const known = this.ids.get(key);
    if (known !== undefined) return known;

    const id = this.size;
    if (id > PALETTE_ID_MASK) throw new Error("Scene block palette is full");
    this.size += 1;
    this.ensureCapacity(this.size);
    const appearance = resolveBlockAppearance(name, states ?? {});
    this.write(id, appearance);
    this.emission[id] = blockEmission(name, states ?? {});
    if (this.names !== undefined) this.writeTextures(id, name, states ?? {}, appearance);
    this.ids.set(key, id);
    return id;
  }

  private writeTextures(
    id: number,
    name: string,
    states: LittleEndianNbtCompoundValue,
    appearance: BlockAppearance,
  ): void {
    const base = name.replace(/^minecraft:/, "");
    if (base === "bed") return this.writeBedTextures(id, states);
    if (base === "standing_banner" || base === "wall_banner") {
      // blocks.json names planks for the support; only the entity sheet holds the cloth.
      const tile = this.textures!.tiles[BANNER_TILE];
      if (tile === undefined) return;
      const cutout = this.cutoutTiles.has(tile);
      const word = packQuadTexture(tile, 0, true) | (cutout ? QUAD_CUTOUT : 0);
      this.textureWords.fill(word, id * 6, id * 6 + 6);
      if (cutout) this.cutout[id] = 2;
      return;
    }
    const textures = resolveBlockTextures(this.names!, name, states, appearance);
    if (textures === undefined) return;
    const ownColor = SELF_TINTED.has(base);
    for (let face = 0; face < 6; face += 1) {
      this.textureWords[id * 6 + face] = this.textureWord(
        textures.faces[face],
        ownColor || this.tints[id * 6 + face] !== TintCode.None,
      );
    }
    this.crossWords[id] = this.textureWord(
      textures.cross,
      this.tints[id * 6 + Face.PositiveY] !== TintCode.None,
    );
    if (TORCH_BLOCK.test(base) && appearance.shape.kind === "box") {
      const { size, inset } = appearance.shape.box;
      const bounds = [inset, 0, inset, 16 - inset, size, 16 - inset] as const;
      for (let face = 0; face < 6; face += 1) {
        const index = id * 6 + face;
        this.textureWords[index] = sheetFaceWord(this.textureWords[index]!, bounds, face, TORCH);
      }
    }
    // Thin and shaped blocks always show what lies behind their holes; leaves and other cubes
    // only in regions built with the faces between them (`VoxelMesher` marks those).
    const shaped = this.shape[id] === Shape.Box || this.shape[id] === Shape.Model;
    let cutout = false;
    for (let face = 0; face < 6; face += 1) {
      const word = this.textureWords[id * 6 + face]!;
      if (word === 0 || !this.cutoutTiles.has(word & 0x3fff)) continue;
      cutout = true;
      if (shaped) this.textureWords[id * 6 + face] = (word | QUAD_CUTOUT) >>> 0;
    }
    this.cutout[id] = !cutout ? 0 : shaped ? 2 : this.shape[id] === Shape.Cube ? 1 : 0;
  }

  /**
   * Beds read the tiles cut from their color's entity texture (see `cutBedTile`): the mattress
   * top turned so its headboard row lies at the head, the sides along the bed, the ends across.
   */
  private writeBedTextures(id: number, states: LittleEndianNbtCompoundValue): void {
    const color = BED_COLORS[typeof states.color === "number" ? states.color & 15 : 0]!;
    const head = states.head_piece_bit === 1;
    // Direction 0 puts the head toward +z, 1 toward -x, 2 toward -z, 3 toward +x.
    const direction = typeof states.direction === "number" ? states.direction & 3 : 0;
    const word = (tile: BedTile, rotation = 0): number => {
      const index = this.textures!.tiles[bedTilePath(color, tile)];
      return index === undefined ? 0 : packQuadTexture(index, rotation, false);
    };
    const side = word(head ? "head_side" : "foot_side");
    const end = word(head ? "head_end" : "foot_end");
    const alongZ = direction % 2 === 0;
    const words = [
      alongZ ? side : end,
      alongZ ? side : end,
      word(head ? "head_top" : "foot_top", [2, 3, 0, 1][direction]),
      word("foot_top"),
      alongZ ? end : side,
      alongZ ? end : side,
    ];
    this.textureWords.set(words, id * 6);
  }

  /** The texture word of a face, tinted as its color is; 0 when the atlas lacks the image. */
  private textureWord(texture: FaceTexture | undefined, tinted: boolean): number {
    if (texture === undefined) return 0;
    const tile = this.textures!.tiles[texture.path];
    return tile === undefined ? 0 : packQuadTexture(tile, texture.rotation, tinted);
  }

  isOpaque(id: number): boolean {
    return this.shape[id] === Shape.Cube || this.shape[id] === Shape.Lava;
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
      case "model":
        this.shape[id] = Shape.Model;
        this.material[id] = shape.material;
        this.models[id] = shape.model;
        this.setBox(id, 16, 0, false);
        break;
      case "lava":
        this.shape[id] = Shape.Lava;
        this.material[id] = QuadMaterial.Emissive;
        this.setBox(id, lavaFill(shape.level), 0, false);
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
    this.emission = grow(this.emission, capacity);
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
    if (this.textures !== undefined) {
      const words = new Uint32Array(capacity * 6);
      words.set(this.textureWords);
      this.textureWords = words;
      const cross = new Uint32Array(capacity);
      cross.set(this.crossWords);
      this.crossWords = cross;
      this.cutout = grow(this.cutout, capacity);
    }
  }
}

function voxelKindOf(shape: BlockShape): number {
  switch (shape.kind) {
    case "lava":
      return VoxelKind.Lava;
    case "model": {
      if (shape.material === QuadMaterial.Glass) return VoxelKind.Glass;
      if (shape.material === QuadMaterial.Emissive) return VoxelKind.Emissive;
      const volume = blockModelParts(shape.model).reduce(
        (sum, { bounds: b }) => sum + (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2]),
        0,
      );
      return volume >= MIN_VOXEL_VOLUME * 16 ** 3 ? solidKind(shape.material) : VoxelKind.Air;
    }
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

/** Falling lava fills its column; exposed source lava is 8/9 high, then decreases by depth. */
export function lavaFill(level: number): number {
  return level >= 8 ? 16 : Math.max(2, Math.round(((8 - level) * 16) / 9));
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

function appearanceKey(
  name: string,
  states: LittleEndianNbtCompoundValue | undefined,
  stateKeys: ReadonlySet<string>,
): string {
  if (states === undefined) return name;
  let key = name;
  const colorStates = BEDROCK_COLOR_STATES[name.replace(/^minecraft:/, "")];
  const keys = Object.keys(states).filter(
    (key) => stateKeys.has(key) || colorStates?.includes(key),
  );

  if (keys.length > 1) keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const state of keys) {
    const value = states[state];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
      key += `|${state}=${value}`;
  }
  return key;
}

function grow(array: Uint8Array, capacity: number): Uint8Array<ArrayBuffer> {
  const grown = new Uint8Array(capacity);
  grown.set(array);
  return grown;
}
