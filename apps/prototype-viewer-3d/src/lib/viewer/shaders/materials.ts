import { QuadMaterial, SOIL_COLOR } from "@mapelix/scene-prototype/format";
import {
  DoubleSide,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
} from "three/webgpu";
import {
  Fn,
  abs,
  cameraFar,
  cameraNear,
  cameraPosition,
  color,
  dot,
  exp,
  float,
  fract,
  fwidth,
  hash,
  max,
  min,
  mix,
  normalWorld,
  normalize,
  perspectiveDepthToViewZ,
  positionView,
  positionWorld,
  reflect,
  screenUV,
  select,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportSharedTexture,
} from "three/tsl";

import type { Atmosphere } from "../atmosphere";
import {
  quadColor,
  quadCovered,
  quadHeight,
  quadMaterial,
  quadOcclusion,
  quadPosition,
  quadSprite,
  quadUV,
} from "./quad";

export interface SceneMaterials {
  readonly terrain: MeshStandardNodeMaterial;
  readonly plants: MeshLambertNodeMaterial;
  readonly translucent: MeshBasicNodeMaterial;
}

export function createSceneMaterials(atmosphere: Atmosphere): SceneMaterials {
  return {
    terrain: createTerrainMaterial(),
    plants: createPlantMaterial(),
    translucent: createTranslucentMaterial(atmosphere),
  };
}

/** A stable random value per block, so flat colors read as individual blocks. */
const blockNoise = Fn(() => {
  const block = positionWorld.sub(normalWorld.mul(0.01)).floor();
  return hash(block.x.mul(12.9898).add(block.y.mul(78.233)).add(block.z.mul(37.719)));
});

/** Soft darkening along block edges while blocks are large on screen. */
const blockBevel = Fn(() => {
  const n = abs(normalWorld);
  const planar = select(
    n.y.greaterThan(0.5),
    positionWorld.xz,
    select(n.x.greaterThan(0.5), positionWorld.zy, positionWorld.xy),
  );
  const inside = fract(planar);
  const edge = min(min(inside.x, inside.y), min(float(1).sub(inside.x), float(1).sub(inside.y)));
  const pixel = max(fwidth(planar.x), fwidth(planar.y));
  const visible = smoothstep(0.3, 0.08, pixel);
  const line = smoothstep(pixel.mul(0.5), pixel.mul(1.5).add(0.05), edge);
  return mix(float(1), mix(float(0.88), float(1), line), visible);
});

/** `color()` converts the sRGB hex to linear, like the decoded quad colors. */
const soil = color(SOIL_COLOR);

/**
 * Grass, podzol, and mycelium sides show soil under a ragged strip of their top
 * color, like Minecraft's grass block side, instead of a flat band of dirt.
 */
const coveredSoil = Fn(() => {
  const n = abs(normalWorld);
  const along = select(n.x.greaterThan(0.5), positionWorld.z, positionWorld.x);
  const pixel = along.mul(16).floor().add(positionWorld.y.floor().mul(131));
  const strip = float(2).add(hash(pixel).mul(3).floor()).div(16);
  const fromTop = float(1).sub(quadUV.y).mul(quadHeight);
  const inSoil = quadCovered.greaterThan(0.5).and(fromTop.greaterThan(strip));
  return select(inSoil, soil, quadColor);
});

function createTerrainMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  material.positionNode = quadPosition();
  const foliage = quadMaterial.equal(QuadMaterial.Foliage);
  const variation = blockNoise()
    .sub(0.5)
    .mul(select(foliage, float(0.26), float(0.09)))
    .add(1);
  // Occlusion mostly darkens sky light, and a little of the sun, like soft contact shadows.
  const contact = mix(float(0.8), float(1), quadOcclusion);
  const glowing = quadMaterial.equal(QuadMaterial.Emissive);
  const bevel = select(glowing, float(1), blockBevel());
  material.colorNode = coveredSoil().mul(variation).mul(bevel).mul(contact);
  material.aoNode = quadOcclusion;
  material.emissiveNode = select(glowing, quadColor.mul(1.6), vec3(0));
  return material;
}

/** Procedural sprite masks for crossed plant quads, in `PlantSprite` order. */
const plantMask = Fn(() => {
  const u = quadUV.x;
  const v = quadUV.y;
  const sprite = quadSprite;
  const blades = abs(fract(u.mul(3.2).add(0.15)).sub(0.5)).mul(2);
  const grass = blades.lessThan(float(1).sub(v).pow(1.2).mul(0.9));
  const stem = abs(u.sub(0.5)).lessThan(0.07).and(v.lessThan(0.72));
  const head = vec2(u, v).sub(vec2(0.5, 0.74)).length().lessThan(0.2);
  const flower = stem.or(head);
  const bush = vec2(u, v)
    .sub(vec2(0.5, 0.52))
    .length()
    .lessThan(float(0.42).add(sin(u.mul(21)).mul(0.04)));
  const crop = fract(u.mul(4))
    .lessThan(0.42)
    .and(v.lessThan(float(0.92).sub(fract(u.mul(4)).mul(0.2))));
  const stalk = abs(u.sub(0.5)).lessThan(0.16);
  const cap = abs(u.sub(0.5))
    .lessThan(float(0.36).mul(float(1).sub(v.sub(0.6).div(0.4).clamp(0, 1).pow(2))))
    .and(v.greaterThan(0.45));
  const mushroom = cap.or(abs(u.sub(0.5)).lessThan(0.08).and(v.lessThan(0.5)));
  return select(
    sprite.lessThan(0.5),
    grass,
    select(
      sprite.lessThan(1.5),
      flower,
      select(
        sprite.lessThan(2.5),
        bush,
        select(sprite.lessThan(3.5), crop, select(sprite.lessThan(4.5), stalk, mushroom)),
      ),
    ),
  );
});

function createPlantMaterial(): MeshLambertNodeMaterial {
  const material = new MeshLambertNodeMaterial({ side: DoubleSide });
  // A gentle sway that grows toward the tips, phased per block so fields ripple.
  const sway = sin(time.mul(1.7).add(positionWorld.x.mul(0.37)).add(positionWorld.z.mul(0.23)));
  material.positionNode = quadPosition().add(
    vec3(sway.mul(0.045), 0, sway.mul(0.03)).mul(quadUV.y),
  );
  const isFlower = quadSprite.greaterThan(0.5).and(quadSprite.lessThan(1.5));
  const petals = vec2(quadUV.x, quadUV.y).sub(vec2(0.5, 0.74)).length().lessThan(0.2);
  const stemColor = vec3(0.12, 0.3, 0.07);
  const base = select(isFlower.and(petals.not()), stemColor, quadColor);
  // Plants darken slightly toward the ground, where neighbors shade them.
  const shade = mix(float(0.78), float(1.12), quadUV.y);
  material.colorNode = base.mul(shade).mul(blockNoise().mul(0.2).add(0.9));
  material.maskNode = plantMask();
  // A fixed view-space up normal, so the back sides of the planes are lit like the front.
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  return material;
}

/**
 * Water and glass. Water refracts the terrain behind it and absorbs light with
 * depth, so shallows show the bed and deep water turns to the biome's color.
 */
function createTranslucentMaterial(atmosphere: Atmosphere): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: true });
  material.positionNode = quadPosition();

  material.colorNode = Fn(() => {
    const isGlass = quadMaterial.equal(QuadMaterial.Glass);
    const top = normalWorld.y.greaterThan(0.5).and(isGlass.not());

    // Two drifting wave layers give the surface normal.
    const p = positionWorld.xz;
    const t = time;
    const wave = vec2(
      sin(p.x.mul(0.9).add(p.y.mul(0.35)).add(t.mul(1.3)))
        .mul(0.6)
        .add(sin(p.x.mul(2.3).sub(p.y.mul(1.7)).add(t.mul(2.1))).mul(0.25)),
      sin(p.y.mul(1.1).sub(p.x.mul(0.4)).add(t.mul(1.1)))
        .mul(0.6)
        .add(sin(p.y.mul(2.7).add(p.x.mul(1.3)).sub(t.mul(1.9))).mul(0.25)),
    );
    // Waves flatten with distance, where their fine pattern would only shimmer.
    const calm = smoothstep(420, 60, positionView.z.negate()).mul(0.07);
    const waveNormal = normalize(vec3(wave.x.mul(calm), 1, wave.y.mul(calm)));
    const normal = select(top, waveNormal, normalWorld);
    const toCamera = normalize(cameraPosition.sub(positionWorld));

    // Refract with a small screen offset, but never sample terrain in front of the surface.
    const surfaceDepth = positionView.z.negate();
    const offset = normal.xz.mul(0.035).div(surfaceDepth.mul(0.02).add(1));
    const bentUV = screenUV.add(offset);
    const depthAt = (uv: Node<"vec2">) =>
      perspectiveDepthToViewZ(viewportDepthTexture(uv).x, cameraNear, cameraFar).negate();
    const bentThickness = depthAt(bentUV).sub(surfaceDepth);
    const sampleUV = select(bentThickness.lessThan(0), screenUV, bentUV);
    const thickness = max(depthAt(sampleUV).sub(surfaceDepth), 0);
    const behind = viewportSharedTexture(sampleUV).rgb;

    // Red fades first, then green, like real water. Glass barely absorbs.
    const extinction = select(isGlass, vec3(0.02), vec3(0.42, 0.13, 0.085));
    const transmitted = exp(extinction.mul(thickness).negate());
    const deep = quadColor.mul(select(isGlass, float(0.9), float(0.22)));
    const body = mix(
      deep,
      behind.mul(select(isGlass, quadColor.mul(0.85).add(0.15), vec3(1))),
      transmitted,
    );

    const fresnel = float(0.02).add(
      float(0.98).mul(
        float(1)
          .sub(max(dot(normal, toCamera), 0))
          .pow(5),
      ),
    );
    const reflected = reflect(toCamera.negate(), normal);
    const skyReflection = atmosphere.sky(
      normalize(vec3(reflected.x, max(reflected.y, 0.02), reflected.z)),
    );
    const glint = max(dot(reflected, atmosphere.sunDirection), 0).pow(500).mul(6);
    const foam = float(1)
      .sub(smoothstep(0.05, 0.55, thickness))
      .mul(select(top, float(0.35), float(0)));

    const surface = mix(body, skyReflection, fresnel.mul(select(isGlass, float(0.5), float(0.85))));
    return surface.add(atmosphere.sunColor.mul(glint)).add(vec3(foam));
  })();
  return material;
}
