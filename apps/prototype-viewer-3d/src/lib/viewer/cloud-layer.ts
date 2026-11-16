import {
  BoxGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  type Vector3,
} from "three/webgpu";
import {
  cameraPosition,
  attribute,
  color,
  float,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  uint,
  vec3,
} from "three/tsl";
import type { SceneContext } from "@mapelix/scene-prototype/dimensions";
import type { Atmosphere } from "./atmosphere";
import { RENDER_ORDER } from "./render-order";

const CELL = 16;
const SIDE = 48;
const HEIGHT = 192;
const WIND = 0.7;
const PERIOD = 4096;

function noise(x: number, z: number): number {
  let n = Math.imul(x & (PERIOD - 1), 374761393) ^ Math.imul(z & (PERIOD - 1), 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
}

/** Broad coherent patches with block-sized edges, deterministic at signed coordinates. */
export function cloudCell(x: number, z: number): boolean {
  const bx = Math.floor(x / 4),
    bz = Math.floor(z / 4),
    fx = x / 4 - bx,
    fz = z / 4 - bz;
  const a = noise(bx, bz) * (1 - fx) + noise(bx + 1, bz) * fx;
  const b = noise(bx, bz + 1) * (1 - fx) + noise(bx + 1, bz + 1) * fx;
  return a * (1 - fz) + b * fz > 0.57;
}

/** One bounded, shadow-free instanced layer, reused across view and dimension changes. */
export class CloudLayer {
  readonly root: InstancedMesh<BoxGeometry, MeshBasicNodeMaterial>;
  private readonly matrix = new Matrix4();
  private readonly faces = new InstancedBufferAttribute(new Uint32Array(SIDE * SIDE), 1).setUsage(
    DynamicDrawUsage,
  );
  private enabled = true;
  private eligible = true;
  private phase = 0;
  private windCell = 0;
  private key = "";

  constructor(atmosphere: Atmosphere, enabled = true) {
    const material = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    material.colorNode = mix(color(0x56617c), color(0xf8faff), atmosphere.daylight)
      .mul(max(normalWorld.y, 0).mul(0.15).add(0.85))
      .mul(float(1).sub(atmosphere.rain.mul(0.2)).sub(atmosphere.storm.mul(0.2)))
      .add(vec3(0.5, 0.6, 0.8).mul(atmosphere.lightning));
    const edge = float(1).sub(
      smoothstep(300, 368, positionWorld.xz.sub(cameraPosition.xz).length()),
    );
    // Overview maps remain readable above the layer, including unlocked far zoom.
    const overview = float(1).sub(smoothstep(256, 512, cameraPosition.y));
    // Fade before crossing the layer: overhead clouds must not wash out the map or water.
    const above = float(1).sub(smoothstep(HEIGHT - 16, HEIGHT, cameraPosition.y));
    // An isometric view looks from a whole plane, partly above the layer; keep it map-like.
    const perspective = float(1).sub(atmosphere.projectionBlend);
    material.opacityNode = edge.mul(overview).mul(above).mul(perspective).mul(0.62);
    const faces = attribute("cloudFaces", "uint");
    material.maskNode = normalWorld.y
      .abs()
      .greaterThan(0.5)
      .or(normalWorld.x.greaterThan(0.5).and(faces.bitAnd(uint(1)).notEqual(uint(0))))
      .or(normalWorld.x.lessThan(-0.5).and(faces.bitAnd(uint(2)).notEqual(uint(0))))
      .or(normalWorld.z.greaterThan(0.5).and(faces.bitAnd(uint(4)).notEqual(uint(0))))
      .or(normalWorld.z.lessThan(-0.5).and(faces.bitAnd(uint(8)).notEqual(uint(0))));
    this.root = new InstancedMesh(new BoxGeometry(CELL, 4, CELL), material, SIDE * SIDE);
    this.root.geometry.setAttribute("cloudFaces", this.faces);
    this.root.name = "Overworld clouds";
    this.root.renderOrder = RENDER_ORDER.clouds;
    this.root.instanceMatrix.setUsage(DynamicDrawUsage);
    this.root.frustumCulled = false;
    this.root.count = 0;
    this.setEnabled(enabled);
  }

  setContext(context: SceneContext): void {
    this.eligible = context.dimension === "overworld" && context.mode === "surface";
    this.root.visible = this.enabled && this.eligible;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled && this.eligible;
  }

  update(delta: number, camera: Vector3): void {
    if (!this.root.visible) return;
    this.phase += delta * WIND;
    const steps = Math.floor(this.phase / CELL);
    this.phase -= steps * CELL;
    // The noise lattice repeats after PERIOD cells of four cloud blocks.
    this.windCell = (this.windCell + steps) % (PERIOD * 4);
    const x = Math.floor((camera.x - this.phase) / CELL),
      z = Math.floor(camera.z / CELL);
    this.root.position.set(x * CELL + this.phase, HEIGHT, z * CELL);
    const key = `${x}/${z}/${this.windCell}`;
    if (key === this.key) return;
    this.key = key;
    let count = 0;
    for (let dz = -SIDE / 2; dz < SIDE / 2; dz++) {
      for (let dx = -SIDE / 2; dx < SIDE / 2; dx++) {
        if (!cloudCell(x + dx - this.windCell, z + dz)) continue;
        const cx = x + dx - this.windCell,
          cz = z + dz;
        this.faces.setX(
          count,
          Number(!cloudCell(cx + 1, cz)) |
            (Number(!cloudCell(cx - 1, cz)) << 1) |
            (Number(!cloudCell(cx, cz + 1)) << 2) |
            (Number(!cloudCell(cx, cz - 1)) << 3),
        );
        this.matrix.makeTranslation((dx + 0.5) * CELL, 0, (dz + 0.5) * CELL);
        this.root.setMatrixAt(count++, this.matrix);
      }
    }
    this.root.count = count;
    this.root.instanceMatrix.needsUpdate = true;
    this.faces.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.root.dispose();
    this.root.geometry.dispose();
    this.root.material.dispose();
  }
}
