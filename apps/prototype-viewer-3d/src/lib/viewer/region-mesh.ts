import type { DecodedSceneRegion } from "@mapelix/scene-prototype/format";
import {
  Box3,
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  Sphere,
  Vector3,
  type Material,
} from "three/webgpu";

import type { SceneMaterials } from "./shaders/materials";

// Every quad instance reuses one unit square. The shader turns its corners into the face.
const corners = new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3);
const normals = new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3);
const triangles = new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1);

/** One streamed region: up to three instanced meshes that share the scene materials. */
export class RegionMesh {
  readonly region: DecodedSceneRegion;
  readonly group = new Group();
  /** GPU bytes held by the quad buffers, for the streaming memory budget. */
  readonly byteLength: number;

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
    this.add(region.plants, materials.plants, bounds, { castShadow: true, renderOrder: 1 });
    this.add(region.translucent, materials.translucent, bounds, {
      castShadow: false,
      renderOrder: 2,
    });
  }

  get isEmpty(): boolean {
    return this.group.children.length === 0;
  }

  dispose(): void {
    for (const child of this.group.children) {
      if (child instanceof Mesh) child.geometry.dispose();
    }
    this.group.clear();
  }

  private add(
    quads: Uint32Array,
    material: Material,
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

    const mesh = new Mesh(geometry, material);
    mesh.castShadow = options.castShadow;
    mesh.receiveShadow = true;
    mesh.renderOrder = options.renderOrder;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
  }
}
