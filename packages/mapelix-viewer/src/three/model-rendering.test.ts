import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicNodeMaterial, Vector3 } from "three/webgpu";
import {
  Face,
  QUAD_LAVA_FLAG,
  QUAD_MODEL_FLAG,
  QuadMaterial,
  decodeSceneRegion,
  encodeSceneRegion,
  modelBoxId,
  packModelWord1,
  packQuadWord0,
  type ModelBounds,
} from "@mapelix/scene-prototype/format";
import { QuadCollider } from "./quad-collider";
import { RegionMesh, RegionMeshPool } from "./region-mesh";
import type { SceneMaterials } from "./shaders/materials";

function region(words: Uint32Array) {
  return decodeSceneRegion(
    encodeSceneRegion({
      level: 0,
      x: 0,
      z: 0,
      minY: 60,
      maxY: 61,
      heights: new Int16Array(64 ** 2).fill(61),
      opaque: words,
      plants: new Uint32Array(),
      translucent: new Uint32Array(),
    }),
  );
}
function modelFace(bounds: ModelBounds) {
  return [
    packQuadWord0(0, 60, 0, Face.PositiveY, QuadMaterial.Solid) | QUAD_MODEL_FLAG,
    packModelWord1(modelBoxId(bounds)),
    0xff7d7d7d,
  ];
}

describe("model collision and lava rendering batches", () => {
  it("reuses bounded mesh shells while dropping old quad arrays and disposes them with their owner", () => {
    const pool = new RegionMeshPool(1);
    const pair = { steady: new MeshBasicNodeMaterial(), fading: new MeshBasicNodeMaterial() };
    const materials = { terrain: pair, lava: pair, plants: pair, water: pair, glass: pair };
    const first = new RegionMesh(
      region(Uint32Array.from(modelFace([0, 0, 0, 16, 8, 16]))),
      materials,
      pool,
    );
    const shell = first.group.children[0] as Mesh;
    const oldAttribute = shell.geometry.getAttribute("quad");
    let disposed = 0;
    shell.addEventListener("dispose", () => disposed++);
    first.dispose();
    expect(pool.retained).toBe(1);
    expect(oldAttribute.array.length).toBe(0);
    const second = new RegionMesh(
      region(Uint32Array.from(modelFace([8, 8, 0, 16, 16, 16]))),
      materials,
      pool,
    );
    expect(second.group.children[0]).toBe(shell);
    expect(shell.geometry.getAttribute("quad").array.length).toBe(3);
    second.dispose();
    pool.dispose();
    expect(disposed).toBe(1);
    expect(pool.retained).toBe(0);
    pair.steady.dispose();
    pair.fading.dispose();
  });
  it("picks the lower tread through the empty half of a stair, and the upper tread beside it", () => {
    const collider = new QuadCollider(
      region(
        Uint32Array.from([...modelFace([0, 0, 0, 16, 8, 16]), ...modelFace([8, 8, 0, 16, 16, 16])]),
      ),
    );
    const direction = new Vector3(0, -1, 0);
    expect(collider.raycast(new Vector3(0.25, 65, 0.5), direction, 10, 0)?.distance).toBeCloseTo(
      4.5,
    );
    expect(collider.raycast(new Vector3(0.75, 65, 0.5), direction, 10, 0)?.distance).toBeCloseTo(4);
  });
  it("draws terrain and lava as views into one buffer and accounts for their actual GPU bytes", () => {
    const data = region(
      Uint32Array.of(
        ...modelFace([0, 0, 0, 16, 8, 16]),
        packQuadWord0(1, 60, 0, Face.PositiveY, QuadMaterial.Emissive),
        0xf0000 | QUAD_LAVA_FLAG,
        0xffd55b13,
      ),
    );
    const pair = { steady: new MeshBasicNodeMaterial(), fading: new MeshBasicNodeMaterial() };
    const mesh = new RegionMesh(data, {
      terrain: pair,
      lava: pair,
      plants: pair,
      water: pair,
      glass: pair,
    } satisfies SceneMaterials);
    expect(mesh.group.children).toHaveLength(2);
    expect(mesh.byteLength).toBe(24);
    for (const child of mesh.group.children) {
      expect((child as Mesh).geometry.getAttribute("quad").array.buffer).toBe(data.opaque.buffer);
    }
    mesh.dispose();
    expect(mesh.group.children).toHaveLength(0);
    pair.steady.dispose();
    pair.fading.dispose();
  });
});
