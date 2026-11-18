import {
  Fn,
  If,
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  cos,
  dFdx,
  dFdy,
  float,
  fract,
  ivec2,
  max,
  mix,
  modelScale,
  normalWorld,
  positionWorld,
  select,
  sin,
  smoothstep,
  step,
  texture,
  textureLoad,
  time,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { Vector2, type Node } from "three/webgpu";

import type { BlockAtlas } from "../block-atlas";
import { quadColor, quadPackedData, quadPosition, quadSprite, quadUV } from "./quad";

/**
 * Block textures for textured regions. Each quad carries a fourth word (see
 * `QUAD_TEXTURED` in `@mapelix/scene-prototype/texture-format`): its atlas tile, quarter
 * turns, and whether the texture takes the quad's biome color. Pixels show the texture where a
 * block is large on screen and the flat color below, with a smooth blend in between measured
 * in screen pixels per block, so perspective and isometric views fade at the same block size.
 */

/**
 * The quad's texture word, 19 bits, shares a flat integer with four light bits: plain terrain uses
 * all 16 varyings WebGPU allows, and the textured terrain and plants never read lava flow (lava
 * keeps its plain material). No interpolation can change these per-face flags.
 */
const textureWord = quadPackedData;

const bit = (word: Node<"uint">, shift: number, mask: number) =>
  float(word.shiftRight(uint(shift)).bitAnd(uint(mask)));

/**
 * The offset of a face drawn from a sheet of parts, as for lanterns and candles: its byte
 * (bits 19 to 26 of the texture word) rides in the plant sprite varying, which only crossed
 * plant quads read. A float holds it exactly; rounding removes interpolation error.
 */
const textureOffset = quadSprite;

/** `quadPosition`, with the quad's texture word for the fragment stage. */
export const texturedQuadPosition = Fn(() => {
  // A variable, so `quadPosition` and its own lava flow and sprite assignments come first.
  const position = quadPosition().toVar();
  const texture = uint(attribute("texture", "uint"));
  textureWord.assign(texture.bitAnd(uint(0x7807ffff)));
  If(bit(uint(attribute("quad", "uvec3").x), 23, 7).lessThan(6), () => {
    textureOffset.assign(bit(texture, 19, 0xff));
  });
  return position;
});

const word = textureWord;
const textureTile = bit(word, 0, 0x3fff);
const textureTurn = bit(word, 14, 3);
const textureTint = bit(word, 16, 1);
const textured = bit(word, 17, 1);
const cutoutQuad = bit(word, 18, 1);
const offset = uint(textureOffset.round());
const offsetAcross = bit(offset, 0, 15);
const offsetDown = bit(offset, 4, 15);

/** Screen sizes, in CSS pixels per block, where textures start to show and are complete. */
export interface TextureFade {
  readonly none: number;
  readonly full: number;
}

/** Brightness of the fill behind the transparent texels of leaves and other cut-out tiles. */
const LEAF_SHADE = 0.5;

export const DEFAULT_TEXTURE_FADE: TextureFade = { none: 4, full: 8 };

export class TextureLook {
  readonly atlas: BlockAtlas;
  /** `none` and `full` of the fade, in CSS pixels per block. */
  readonly fade = uniform(new Vector2(DEFAULT_TEXTURE_FADE.none, DEFAULT_TEXTURE_FADE.full));
  /** Height of the view in CSS pixels. */
  readonly viewHeight = uniform(1);

  constructor(atlas: BlockAtlas) {
    this.atlas = atlas;
  }

  setFade(fade: TextureFade): void {
    this.fade.value.set(fade.none, fade.full);
  }

  /**
   * CSS pixels covered by one block at this pixel, from the projection itself: the same
   * measure in perspective, isometric and the blend between them.
   */
  private pixelsPerBlock(): Node<"float"> {
    // From the world position, already passed to the fragment stage: `positionView` would take
    // one more varying than WebGPU allows here.
    const clip = cameraProjectionMatrix.mul(cameraViewMatrix.mul(vec4(positionWorld, 1)));
    // The vertical scale of the projection, its second column's second row. Matrix nodes index
    // columns at run time; their typings leave `element` out.
    const projection = cameraProjectionMatrix as unknown as {
      element(index: number): Node<"vec4">;
    };
    const scale = projection.element(1).y;
    return this.viewHeight.mul(0.5).mul(scale).div(max(clip.w, 1e-4)).mul(modelScale.x);
  }

  /** How much of the texture shows, 0 to 1. Quads without a texture keep their color. */
  amount(): Node<"float"> {
    return smoothstep(this.fade.x, this.fade.y, this.pixelsPerBlock()).mul(textured);
  }

  /**
   * Samples the quad's tile at continuous texture coordinates in blocks. The fraction picks the
   * texel; the gradients come from the continuous coordinates, so mipmaps never jump where a
   * coordinate wraps. Animated tiles step through the frames that follow them.
   */
  private cellOf(tile: Node<"float">): Node<"vec2"> {
    const columns = float(this.atlas.columns);
    return vec2(tile.mod(columns), tile.div(columns).floor());
  }

  /** The quad's tile entry: frames (low, high byte), ticks per frame, overlay; 0 to 255. */
  private tileInfo(): Node<"vec4"> {
    return textureLoad(this.atlas.animation, ivec2(this.cellOf(textureTile))).mul(255);
  }

  private sample(coords: Node<"vec2">): Node<"vec4"> {
    const { atlas } = this;
    const info = this.tileInfo();
    const frames = max(info.x.add(info.y.mul(256)), 1);
    const ticks = max(info.z, 1);
    const frame = time.mul(20).div(ticks).floor().mod(frames);
    const cell = this.cellOf(textureTile.add(frame));
    const size = vec2(atlas.width, atlas.height);
    const texel = cell.mul(atlas.cellSize).add(atlas.gutter).add(fract(coords).mul(atlas.tileSize));
    const scale = vec2(atlas.tileSize, atlas.tileSize).div(size);
    return texture(atlas.image, texel.div(size)).grad(
      dFdx(coords).mul(scale),
      dFdy(coords).mul(scale),
    );
  }

  private tint(): Node<"vec3"> {
    return select(textureTint.greaterThan(0.5), quadColor, vec3(1, 1, 1));
  }

  /**
   * A block face's texture at this pixel. Coordinates follow the game: sides read with the
   * texture's top up and its left on the left seen from outside, tops with north up.
   */
  private faceTexel(): Node<"vec4"> {
    const p = positionWorld.div(modelScale.x);
    const n = normalWorld;
    const coords = select(
      n.y.greaterThan(0.5),
      vec2(p.x, p.z),
      select(
        n.y.lessThan(-0.5),
        vec2(p.x, p.z.negate()),
        select(
          n.x.greaterThan(0.5),
          vec2(p.z.negate(), p.y.negate()),
          select(
            n.x.lessThan(-0.5),
            vec2(p.z, p.y.negate()),
            select(n.z.greaterThan(0.5), vec2(p.x, p.y.negate()), vec2(p.x.negate(), p.y.negate())),
          ),
        ),
      ),
    );
    // Quarter turns, for the sides of lying logs: (x, y) becomes (y, -x) per turn.
    const angle = textureTurn.mul(Math.PI / 2);
    const c = cos(angle).round();
    const s = sin(angle).round();
    const turned = vec2(coords.x.mul(c).add(coords.y.mul(s)), coords.y.mul(c).sub(coords.x.mul(s)));
    // Faces drawn from a sheet of parts move onto their rectangle, in sixteenths of a block.
    return this.sample(turned.add(vec2(offsetAcross, offsetDown).div(16)));
  }

  /**
   * Blends a terrain color toward the face texture. Texels a pack leaves transparent, as in
   * leaves, show a dark shade of the quad's own color, the leaves' tint or their average
   * color, so a canopy stays opaque. Cut-out faces (see `cutoutMask`) lose those texels where
   * the texture shows, and blend from their plain color before.
   */
  terrain(plain: Node<"vec3">): Node<"vec3"> {
    const texel = this.faceTexel();
    const tint = this.tint();
    const fill = select(cutoutQuad.greaterThan(0.5), quadColor, quadColor.mul(LEAF_SHADE));
    const opaque = mix(fill, texel.rgb.mul(tint), step(0.5, texel.a));
    // An overlay tile's alpha marks the pixels that take the quad color: the grass strip of a
    // grass block side, whose quad color is the grass color.
    const overlay = mix(texel.rgb, texel.rgb.mul(quadColor), texel.a);
    const color = select(this.tileInfo().w.greaterThan(127), overlay, opaque);
    return mix(plain, color, this.amount());
  }

  /**
   * False at the transparent texels of cut-out faces where their texture shows: the ground
   * under leaf litter, the faces and sky behind detailed leaves. Below the fade they stay
   * filled, as the texture blends from a flat color.
   */
  cutoutMask(): Node<"bool"> {
    return this.amount()
      .greaterThan(0.5)
      .and(cutoutQuad.greaterThan(0.5))
      .and(this.faceTexel().a.lessThan(0.5))
      .not();
  }

  /** Plant sprites: the crossed quad shows the whole tile, top up. */
  private plantTexel(): Node<"vec4"> {
    return this.sample(vec2(quadUV.x, float(1).sub(quadUV.y)));
  }

  plant(plain: Node<"vec3">, shade: Node<"float">): Node<"vec3"> {
    return mix(plain, this.plantTexel().rgb.mul(this.tint()).mul(shade), this.amount());
  }

  /** The texture's own cutout where it shows, the procedural sprite elsewhere. */
  plantMask(procedural: Node<"bool">): Node<"bool"> {
    return select(
      this.amount().greaterThan(0.5),
      this.plantTexel().a.greaterThanEqual(0.5),
      procedural,
    );
  }
}
