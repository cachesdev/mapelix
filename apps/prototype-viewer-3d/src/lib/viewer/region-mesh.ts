import { QuadMaterial, unpackQuad, type DecodedSceneRegion } from "@mapelix/scene-prototype/format";
import {
  Box3,
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Sphere,
  Vector2,
  Vector3,
} from "three/webgpu";

import type { MaterialPair, SceneMaterials } from "./shaders/materials";

// Every quad instance reuses one unit square. The shader turns its corners into the face.
const corners = new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3);
const normals = new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
const triangles = new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

interface Layer {
  readonly mesh: Mesh;
  readonly materials: MaterialPair;
}

/** One streamed region: up to four instanced meshes that share the scene materials. */
export class RegionMesh {
  readonly region: DecodedSceneRegion;
  readonly group = new Group();
  /** GPU bytes held by the quad buffers, for the streaming memory budget. */
  readonly byteLength: number;
  /** The screen noise range this region draws while fading. See `SceneMaterials`. */
  private readonly fade = new Vector2(0, 1);
  private readonly layers: Layer[] = [];

  constructor(region: DecodedSceneRegion, materials: SceneMaterials) {
    this.region = region;
    this.byteLength =
      region.opaque.byteLength + region.plants.byteLength + region.translucent.byteLength;
    this.group.position.set(region.originX, 0, region.originZ);
    this.group.scale.set(region.cellSize, 1, region.cellSize);
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();

    const bounds = new Box3(
      new Vector3(0, region.minY, 0),
      new Vector3(region.gridSize, Math.max(region.maxY, region.minY + 1), region.gridSize),
    );
    const detailed = region.level <= 1;
    this.add(region.opaque, materials.terrain, bounds, { castShadow: detailed, renderOrder: 0 });
    // Grass and flowers do not cast shadows in Minecraft, and skipping them keeps shadows cheap.
    this.add(region.plants, materials.plants, bounds, { castShadow: false, renderOrder: 1 });
    const { water, glass } = splitGlass(region.translucent);
    this.add(water, materials.water, bounds, { castShadow: false, renderOrder: 2 });
    // Glass draws after all water, so the water behind it shows through.
    this.add(glass, materials.glass, bounds, { castShadow: false, renderOrder: 3 });
  }

  get isEmpty(): boolean {
    return this.layers.length === 0;
  }

  /** Draws only the part of the screen noise from `low` to `high`, or everything when unset. */
  setFade(range?: { readonly low: number; readonly high: number }): void {
    this.fade.set(range?.low ?? 0, range?.high ?? 1);
    for (const { mesh, materials } of this.layers) {
      mesh.material = range === undefined ? materials.steady : materials.fading;
    }
  }

  dispose(): void {
    for (const { mesh } of this.layers) mesh.geometry.dispose();
    this.layers.length = 0;
    this.group.clear();
  }

  private add(
    quads: Uint32Array,
    materials: MaterialPair,
    bounds: Box3,
    options: { readonly castShadow: boolean; readonly renderOrder: number },
  ): void {
    if (quads.length === 0) return;
    const geometry = new InstancedBufferGeometry();
    geometry.setIndex(triangles);
    geometry.setAttribute("position", corners);
    geometry.setAttribute("normal", normals);
    geometry.setAttribute("quad", new InstancedBufferAttribute(quads, 3));
    geometry.instanceCount = quads.length / 3;
    geometry.boundingBox = bounds;
    geometry.boundingSphere = bounds.getBoundingSphere(new Sphere());

    const mesh = new Mesh(geometry, materials.steady);
    mesh.castShadow = options.castShadow;
    mesh.receiveShadow = true;
    mesh.renderOrder = options.renderOrder;
    mesh.matrixAutoUpdate = false;
    mesh.userData.fade = this.fade;
    this.group.add(mesh);
    this.layers.push({ mesh, materials });
  }
}

/** Separates the glass quads of a translucent list from its water quads. */
function splitGlass(quads: Uint32Array): { water: Uint32Array; glass: Uint32Array } {
  const water: number[] = [];
  const glass: number[] = [];
  for (let index = 0; index < quads.length / 3; index += 1) {
    const target = unpackQuad(quads, index).material === QuadMaterial.Glass ? glass : water;
    target.push(...quads.subarray(index * 3, index * 3 + 3));
  }
  return { water: Uint32Array.from(water), glass: Uint32Array.from(glass) };
}
