import { MeshStandardNodeMaterial, type Node } from "three/webgpu";
import {
  Fn,
  abs,
  color,
  cos,
  float,
  fract,
  fwidth,
  hash,
  max,
  mix,
  normalWorld,
  positionWorld,
  select,
  sin,
  smoothstep,
  time,
  uint,
  vec2,
  vec4,
} from "three/tsl";

import type { Atmosphere } from "../atmosphere";
import { quadLavaFlow, quadPosition } from "./quad";

/** Keep negative lattice coordinates through signed conversion, then mix their integer bits. */
function latticeHash(cell: Node<"vec2">): Node<"float"> {
  const x = cell.x.toInt().toUint().mul(uint(1597334677));
  const y = cell.y.toInt().toUint().mul(uint(3812015801));
  return hash(x.bitXor(y));
}

/** Smooth value noise with four samples; evaluated only on lava, never on ordinary terrain. */
function noise(p: Node<"vec2">): Node<"float"> {
  const cell = p.floor();
  const f = fract(p);
  const weight = f.mul(f).mul(float(3).sub(f.mul(2)));
  return mix(
    mix(latticeHash(cell), latticeHash(cell.add(vec2(1, 0))), weight.x),
    mix(latticeHash(cell.add(vec2(0, 1))), latticeHash(cell.add(vec2(1, 1))), weight.x),
    weight.y,
  );
}

/**
 * Original procedural pattern, calibrated to lava_still/flow in the supplied Bedrock ZIP.
 * Numeric colors only: no Mojang image assets, image requests, or texture-atlas dependency.
 * Still frames advance every 16 ticks, flow frames every 10 ticks in that archive.
 */
const lavaSurface = Fn(() => {
  const top = abs(normalWorld.y).greaterThan(0.5);
  const along = select(abs(normalWorld.x).greaterThan(0.5), positionWorld.z, positionWorld.x);
  const projected = select(top, positionWorld.xz, vec2(along, positionWorld.y));
  const footprint = max(fwidth(projected.x), fwidth(projected.y));
  const pixels = projected.mul(16).floor().div(16);
  const t = time.div(select(top, float(0.8), float(0.5)));
  // World-space coordinates make merged quads, neighboring regions and all LODs share a phase.
  const angle = quadLavaFlow
    .round()
    .sub(1)
    .mul(Math.PI / 4);
  const horizontalDrift = select(
    quadLavaFlow.greaterThan(0.5),
    vec2(cos(angle), sin(angle)).mul(t.mul(-0.1)),
    vec2(sin(t.mul(0.13)), sin(t.mul(0.11).add(2))).mul(0.13),
  );
  const drift = select(top, horizontalDrift, vec2(float(0), t.mul(0.12)));
  const p = pixels.add(drift);
  const curl = vec2(noise(p.mul(0.8).add(t.mul(0.035))), noise(p.mul(0.8).sub(t.mul(0.03)))).sub(
    0.5,
  );
  const broad = noise(p.mul(1.3).add(curl.mul(0.8)));
  const fine = noise(p.mul(4).sub(drift.mul(0.6)));
  const detail = float(1).sub(smoothstep(0.06, 0.45, footprint));
  const field = mix(broad, broad.mul(0.68).add(fine.mul(0.32)), detail);
  const veins = float(1).sub(smoothstep(0.025, 0.13, abs(field.sub(0.51))));
  const bodyHeat = smoothstep(0.35, 0.85, field);
  const hot = max(bodyHeat.mul(0.65), veins);
  // Source luminance quantiles: #cb3f08, #d4560f, #da6b19, #e38e2f.
  const body = mix(color(0xcb3f08).mul(0.42), color(0xd4560f), smoothstep(0.25, 0.65, field));
  const surface = mix(body, color(0xe38e2f), hot.mul(0.6).add(bodyHeat.mul(0.4)));
  // Fade subpixel contrast and animation into the stable sampled color at the horizon.
  const visible = float(1).sub(smoothstep(0.45, 1.4, footprint));
  return vec4(mix(color(0xd55b13), surface, visible), mix(float(0.3), hot, visible));
});

export function createLavaMaterial(atmosphere: Atmosphere): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  material.positionNode = quadPosition();
  const surface = lavaSurface();
  material.colorNode = surface.rgb.mul(0.16);
  // The existing bloom pass sees only the hottest veins. Lamps and global bloom stay unchanged.
  const radiance = float(0.95)
    .add(surface.a.pow(6).mul(3.6))
    .mul(mix(float(1), float(0.85), atmosphere.daylight));
  material.emissiveNode = surface.rgb.mul(radiance);
  return material;
}
