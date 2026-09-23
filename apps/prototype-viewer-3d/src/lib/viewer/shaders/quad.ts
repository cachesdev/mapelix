import {
  Fn,
  attribute,
  dot,
  float,
  mix,
  normalLocal,
  positionGeometry,
  select,
  sRGBTransferEOTF,
  uint,
  varyingProperty,
  vec2,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * Rebuilds packed scene quads on the GPU. Each instance is one quad of three
 * `uint32` words; the four vertices of a shared unit square become its corners.
 * The bit layout matches `@mapelix/scene-prototype/format`.
 */

/** Linear face color. */
export const quadColor = varyingProperty("vec3", "vQuadColor");
/** Corner occlusion interpolated across the face, from 0 (dark) to 1 (lit). */
export const quadOcclusion = varyingProperty("float", "vQuadOcclusion");
/** Position inside the quad from (0, 0) to (1, 1), used by plant sprites. */
export const quadUV = varyingProperty("vec2", "vQuadUV");
/** `QuadMaterial` code of the face. */
export const quadMaterial = varyingProperty("float", "vQuadMaterial");
/** `PlantSprite` code of the face. */
export const quadSprite = varyingProperty("float", "vQuadSprite");
/** 1 for covered soil sides, which draw soil below a strip of the quad color. */
export const quadCovered = varyingProperty("float", "vQuadCovered");
/** Quad size in blocks along its second tangent, which is height for side faces. */
export const quadHeight = varyingProperty("float", "vQuadHeight");

const bits = (word: Node<"uint">, shift: number, mask: number) =>
  float(word.shiftRight(uint(shift)).bitAnd(uint(mask)));

/** Occlusion levels 0 through 3 mapped to light. Level 0 still keeps some bounce light. */
const occlusionCurve = (level: Node<"float">) => mix(float(0.5), float(1), level.div(3).pow(0.8));

export const quadPosition = Fn(() => {
  const words = attribute("quad", "uvec3");
  const word0 = uint(words.x);
  const word1 = uint(words.y);
  const word2 = uint(words.z);

  const cell = vec3(bits(word0, 0, 127), bits(word0, 14, 511).sub(64), bits(word0, 7, 127));
  const face = bits(word0, 23, 7);
  const width = bits(word1, 0, 127).add(1);
  const height = bits(word1, 7, 511).add(1);
  const size = bits(word1, 16, 15).add(1).div(16);
  const inset = bits(word1, 20, 7).div(16);
  const anchoredTop = bits(word1, 23, 1);

  // Corner occlusion, and the diagonal that keeps it from smearing across the quad.
  const occlusion0 = bits(word2, 24, 3);
  const occlusion1 = bits(word2, 26, 3);
  const occlusion2 = bits(word2, 28, 3);
  const occlusion3 = bits(word2, 30, 3);
  const flip = select(occlusion0.add(occlusion2).lessThan(occlusion1.add(occlusion3)), 1, 0);

  // Faces whose tangents turn clockwise walk the corners backwards to stay front facing.
  const mirrored = face.equal(0).or(face.equal(2)).or(face.equal(5));
  const vertex = positionGeometry.x
    .add(positionGeometry.y.mul(3))
    .sub(positionGeometry.x.mul(positionGeometry.y).mul(2));
  const corner = select(mirrored, float(8).sub(vertex).sub(flip).mod(4), vertex.add(flip).mod(4));
  const cornerU = select(corner.equal(1).or(corner.equal(2)), float(1), float(0));
  const cornerV = select(corner.greaterThanEqual(2), float(1), float(0));
  const cornerOcclusion = select(
    corner.equal(0),
    occlusion0,
    select(corner.equal(1), occlusion1, select(corner.equal(2), occlusion2, occlusion3)),
  );

  // Box extents inside the cell. Slabs, carpets, and posts are boxes too.
  const bottom = anchoredTop.mul(float(1).sub(size));
  const low = vec3(inset, bottom, inset);
  const high = vec3(float(1).sub(inset), bottom.add(size), float(1).sub(inset));

  const axis = face.div(2).floor();
  const normalAxis = select(
    axis.equal(0),
    vec3(1, 0, 0),
    select(axis.equal(1), vec3(0, 1, 0), vec3(0, 0, 1)),
  );
  const uAxis = select(axis.equal(0), vec3(0, 0, 1), vec3(1, 0, 0));
  const vAxis = select(axis.equal(1), vec3(0, 0, 1), vec3(0, 1, 0));
  const positive = face.mod(2).equal(0);

  const boxPosition = cell
    .add(normalAxis.mul(select(positive, dot(high, normalAxis), dot(low, normalAxis))))
    .add(uAxis.mul(mix(dot(low, uAxis), width.sub(1).add(dot(high, uAxis)), cornerU)))
    .add(vAxis.mul(mix(dot(low, vAxis), height.sub(1).add(dot(high, vAxis)), cornerV)));
  const boxNormal = normalAxis.mul(select(positive, float(1), float(-1)));

  // Plants are two diagonal planes through the cell.
  const crossB = face.equal(7);
  const along = mix(inset, float(1).sub(inset), cornerU);
  const crossPosition = cell.add(
    vec3(select(crossB, float(1).sub(along), along), cornerV.mul(size), along),
  );
  const plant = face.greaterThanEqual(6);
  // Plants are lit like the ground they grow on, as Minecraft does for crossed models.
  normalLocal.assign(select(plant, vec3(0, 1, 0), boxNormal));

  const color = vec3(bits(word2, 16, 255), bits(word2, 8, 255), bits(word2, 0, 255)).div(255);
  quadColor.assign(sRGBTransferEOTF(color));
  quadOcclusion.assign(select(plant, float(1), occlusionCurve(cornerOcclusion)));
  quadUV.assign(vec2(cornerU, cornerV));
  quadMaterial.assign(bits(word0, 26, 15));
  quadSprite.assign(bits(word1, 24, 7));
  quadCovered.assign(bits(word0, 30, 1));
  quadHeight.assign(height);

  return select(plant, crossPosition, boxPosition);
});
