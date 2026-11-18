import { QuadMaterial, SOIL_COLOR } from "@mapelix/scene-prototype/format";
import {
  DoubleSide,
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshStandardNodeMaterial,
  Vector2,
  type Material,
  type Node,
  type NodeMaterial,
} from "three/webgpu";
import {
  Fn,
  abs,
  bool,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrixInverse,
  color,
  dot,
  exp,
  float,
  fract,
  fwidth,
  getViewPosition,
  hash,
  interleavedGradientNoise,
  max,
  min,
  mix,
  modelScale,
  normalWorld,
  normalize,
  perspectiveDepthToViewZ,
  positionView,
  positionWorld,
  reflect,
  screenCoordinate,
  screenUV,
  select,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  viewportDepthTexture,
  viewportSharedTexture,
} from "three/tsl";

import type { Atmosphere } from "../atmosphere";
import { createLavaMaterial } from "./lava";
import { texturedQuadPosition, type TextureLook } from "./textured";
import {
  quadColor,
  quadBlockLight,
  quadCovered,
  quadHeight,
  quadMaterial,
  quadOcclusion,
  quadPosition,
  quadSprite,
  quadUV,
} from "./quad";

/**
 * A material and its cross-fading twin. Regions draw with `fading` only while they
 * appear or disappear, so steady terrain keeps a shader without discards.
 */
export interface MaterialPair {
  readonly steady: Material;
  readonly fading: Material;
}

export interface SceneMaterials {
  readonly terrain: MaterialPair;
  readonly lava: MaterialPair;
  readonly plants: MaterialPair;
  readonly water: MaterialPair;
  readonly glass: MaterialPair;
}

export function createSceneMaterials(atmosphere: Atmosphere, clip?: Node<"bool">): SceneMaterials {
  return {
    terrain: withFading(createTerrainMaterial(atmosphere), clip),
    lava: withFading(createLavaMaterial(atmosphere), clip),
    plants: withFading(createPlantMaterial(atmosphere), clip ? plantMask().and(clip) : plantMask()),
    water: withFading(createWaterMaterial(atmosphere), clip),
    glass: withFading(createGlassMaterial(atmosphere), clip),
  };
}

/**
 * Materials for textured regions. Terrain and plants draw the block textures near the camera,
 * terrain with its cut-out faces (see `TextureLook.cutoutMask`); lava, water and glass are the
 * plain materials, shared.
 */
export function createTexturedMaterials(
  atmosphere: Atmosphere,
  plain: SceneMaterials,
  look: TextureLook,
  clip?: Node<"bool">,
): SceneMaterials {
  const mask = look.plantMask(plantMask());
  const terrainMask = clip ? look.cutoutMask().and(clip) : look.cutoutMask();
  return {
    ...plain,
    terrain: withFading(createTerrainMaterial(atmosphere, look), terrainMask),
    plants: withFading(createPlantMaterial(atmosphere, look), clip ? mask.and(clip) : mask),
  };
}

/**
 * The range of screen noise each mesh draws, read from `mesh.userData.fade`. A region
 * fading in draws [0, t) while the one it replaces draws [t, 1), so every pixel shows
 * exactly one of them.
 */
const fadeRange = uniform(new Vector2(0, 1)).onObjectUpdate(
  ({ object }) => object?.userData.fade as Vector2 | undefined,
);

/** Pairs `material` with a fading copy. `mask` is the material's own cutout, if any. */
function withFading(material: NodeMaterial, mask?: Node<"bool">): MaterialPair {
  const noise = interleavedGradientNoise(screenCoordinate);
  const inRange = noise.greaterThanEqual(fadeRange.x).and(noise.lessThan(fadeRange.y));
  material.maskNode = mask ?? null;
  const fading = material.clone();
  fading.maskNode = mask === undefined ? inRange : mask.and(inRange);
  // Shadows ignore the fade, so the shadow map stays whole if it refreshes mid-fade.
  fading.maskShadowNode = mask ?? bool(true);
  return { steady: material, fading };
}

/**
 * World position in cells. Cells are blocks up close and wider cubes farther out, so
 * noise, bevels, and grass strips follow each voxel the way they follow a block.
 */
const positionCell = positionWorld.div(modelScale.x);

/** A stable random value per cell, so flat colors read as individual blocks. */
const blockNoise = Fn(() => {
  const block = positionCell.sub(normalWorld.mul(0.01)).floor();
  return hash(block.x.mul(12.9898).add(block.y.mul(78.233)).add(block.z.mul(37.719)));
});

/** Soft darkening along cell edges while cells are large on screen. */
const blockBevel = Fn(() => {
  const n = abs(normalWorld);
  const planar = select(
    n.y.greaterThan(0.5),
    positionCell.xz,
    select(n.x.greaterThan(0.5), positionCell.zy, positionCell.xy),
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

/** Baked local fill, sharing the packed quad varying; sun, shadows and weather stay dynamic. */
function blockLight(atmosphere: Atmosphere): Node<"vec3"> {
  const surfaceDay = atmosphere.daylight.mul(select(atmosphere.environment.equal(0), 1, 0));
  return vec3(1, 0.78, 0.5)
    .mul(quadBlockLight.pow(2))
    .mul(mix(1.5, 0.3, surfaceDay));
}

/**
 * Grass, podzol, and mycelium sides show soil under a ragged strip of their top
 * color, like Minecraft's grass block side, instead of a flat band of dirt.
 */
const coveredSoil = Fn(() => {
  const n = abs(normalWorld);
  const along = select(n.x.greaterThan(0.5), positionCell.z, positionCell.x);
  const pixel = along.mul(16).floor().add(positionCell.y.floor().mul(131));
  const strip = float(2).add(hash(pixel).mul(3).floor()).div(16);
  const fromTop = float(1).sub(quadUV.y).mul(quadHeight);
  const inSoil = quadCovered.greaterThan(0.5).and(fromTop.greaterThan(strip));
  return select(inSoil, soil, quadColor);
});

function createTerrainMaterial(
  atmosphere: Atmosphere,
  look?: TextureLook,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  material.positionNode = look === undefined ? quadPosition() : texturedQuadPosition();
  const foliage = quadMaterial.equal(QuadMaterial.Foliage);
  const variation = blockNoise()
    .sub(0.5)
    .mul(select(foliage, float(0.26), float(0.09)))
    .add(1);
  // Occlusion mostly darkens sky light, and a little of the sun, like soft contact shadows.
  const contact = mix(float(0.8), float(1), quadOcclusion);
  const glowing = quadMaterial.equal(QuadMaterial.Emissive);
  const bevel = select(glowing, float(1), blockBevel());
  const wet = atmosphere.rain.mul(normalWorld.y.max(0)).mul(select(foliage.or(glowing), 0, 1));
  const surface = coveredSoil().mul(variation).mul(bevel);
  material.colorNode = (look === undefined ? surface : look.terrain(surface))
    .mul(contact)
    .mul(float(1).sub(wet.mul(0.12)));
  material.roughnessNode = mix(1, 0.24, wet);
  material.aoNode = quadOcclusion;
  // Lamps glow harder at night, bright enough for the bloom pass to pick them up.
  const glow = mix(float(4.2), float(1.4), atmosphere.daylight);
  material.emissiveNode = select(
    glowing,
    (look === undefined ? quadColor : look.terrain(quadColor)).mul(glow),
    // Local fill follows sky occlusion; emissive output otherwise bypasses material.aoNode.
    material.colorNode.mul(
      max(vec3(atmosphere.caveLight), blockLight(atmosphere).mul(quadOcclusion)),
    ),
  );
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

function createPlantMaterial(atmosphere: Atmosphere, look?: TextureLook): MeshLambertNodeMaterial {
  const material = new MeshLambertNodeMaterial({ side: DoubleSide });
  // A gentle sway that grows toward the tips, phased per block so fields ripple.
  const sway = sin(time.mul(1.7).add(positionWorld.x.mul(0.37)).add(positionWorld.z.mul(0.23)));
  material.positionNode = (look === undefined ? quadPosition() : texturedQuadPosition()).add(
    vec3(sway.mul(0.045), 0, sway.mul(0.03)).mul(quadUV.y),
  );
  const isFlower = quadSprite.greaterThan(0.5).and(quadSprite.lessThan(1.5));
  const petals = vec2(quadUV.x, quadUV.y).sub(vec2(0.5, 0.74)).length().lessThan(0.2);
  const stemColor = vec3(0.12, 0.3, 0.07);
  const base = select(isFlower.and(petals.not()), stemColor, quadColor);
  // Plants darken slightly toward the ground, where neighbors shade them.
  const shade = mix(float(0.78), float(1.12), quadUV.y);
  const plain = base.mul(shade).mul(blockNoise().mul(0.2).add(0.9));
  material.colorNode = look === undefined ? plain : look.plant(plain, shade);
  // A fixed view-space up normal, so the back sides of the planes are lit like the front.
  material.normalNode = transformNormalToView(vec3(0, 1, 0));
  // Three 0.186 NodeMaterial supports this for Lambert too; its Lambert typings omit it.
  (material as MeshLambertNodeMaterial & { emissiveNode: Node<"vec3"> }).emissiveNode = max(
    quadColor.mul(atmosphere.caveLight),
    material.colorNode.mul(blockLight(atmosphere)),
  );
  return material;
}

/** Schlick's approximation: a surface reflects more as the view grazes it. */
const fresnel = (normal: Node<"vec3">, toCamera: Node<"vec3">) =>
  float(0.02).add(
    float(0.98).mul(
      float(1)
        .sub(max(dot(normal, toCamera), 0))
        .pow(5),
    ),
  );

/** The sky mirrored in a surface, and the sun's glint on it. */
function reflection(atmosphere: Atmosphere, normal: Node<"vec3">, toCamera: Node<"vec3">) {
  const reflected = reflect(toCamera.negate(), normal);
  const sky = atmosphere.sky(normalize(vec3(reflected.x, max(reflected.y, 0.02), reflected.z)));
  const glint = max(dot(reflected, atmosphere.sunDirection), 0).pow(500).mul(6);
  return { sky, glint: atmosphere.sunColor.mul(glint) };
}

/**
 * Water refracts the terrain behind it and absorbs light with depth, so shallows
 * show the bed and deep water turns to the biome's color.
 */
function createWaterMaterial(atmosphere: Atmosphere): MeshBasicNodeMaterial {
  // Keep the depth target across object/shader recompilation and view switches.
  const retainedViewportDepth = viewportDepthTexture();
  const retainedViewportColor = viewportSharedTexture();
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: true });
  material.positionNode = quadPosition();

  material.colorNode = Fn(() => {
    const top = normalWorld.y.greaterThan(0.5);

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
    // Blended and isometric projections are not perspective; their depth goes through the
    // inverse projection. The perspective path stays exactly as it was. The depth sample is a
    // variable: shared by both branches inline, it was emitted inside one branch only.
    const depthAt = (uv: Node<"vec2">) => {
      const depth = retainedViewportDepth.sample(uv).x.toVar();
      return select(
        atmosphere.projectionBlend.greaterThan(0),
        getViewPosition(uv, depth, cameraProjectionMatrixInverse).z,
        perspectiveDepthToViewZ(depth, cameraNear, cameraFar),
      ).negate();
    };
    const bentThickness = depthAt(bentUV).sub(surfaceDepth);
    const sampleUV = select(bentThickness.lessThan(0), screenUV, bentUV);
    const thickness = max(depthAt(sampleUV).sub(surfaceDepth), 0);
    const behind = retainedViewportColor.sample(sampleUV).rgb;

    // Red fades first, then green, like real water.
    const transmitted = exp(vec3(0.42, 0.13, 0.085).mul(thickness).negate());
    // Water has no lighting of its own, so its body color follows the daylight.
    const deep = quadColor
      .mul(0.22)
      .mul(max(vec3(mix(float(0.05), float(1), atmosphere.daylight)), blockLight(atmosphere)));
    const body = mix(deep, behind, transmitted);

    const { sky, glint } = reflection(atmosphere, normal, toCamera);
    const foam = float(1)
      .sub(smoothstep(0.05, 0.55, thickness))
      .mul(select(top, float(0.35), float(0)));
    return mix(body, sky, fresnel(normal, toCamera).mul(0.85)).add(glint).add(vec3(foam));
  })();
  return material;
}

/**
 * Glass blends over what is already drawn, water included, like Minecraft's stained
 * glass. It turns more opaque toward grazing angles, where it mirrors the sky.
 */
function createGlassMaterial(atmosphere: Atmosphere): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  material.positionNode = quadPosition();

  const toCamera = normalize(cameraPosition.sub(positionWorld));
  const reflectance = fresnel(normalWorld, toCamera);
  const { sky, glint } = reflection(atmosphere, normalWorld, toCamera);
  material.colorNode = mix(
    quadColor.mul(max(vec3(1), blockLight(atmosphere))),
    sky,
    reflectance,
  ).add(glint);
  material.opacityNode = mix(float(0.22), float(0.9), reflectance);
  return material;
}
