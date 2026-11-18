import {
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from "three/webgpu";
import { RegionMeshPool } from "@mapelix/viewer/three/region-mesh";
import { quadBlockLight, quadColor, quadPosition } from "@mapelix/viewer/three/shaders/quad";
import {
  Face,
  FULL_BOX,
  QuadMaterial,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
} from "@mapelix/scene-prototype/format";

function geometry(count: number, auxiliary: boolean): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), 3),
  );
  geometry.setAttribute(
    "normal",
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
  );
  const words = new Uint32Array(count * 3);
  for (let i = 0; i < count; i++)
    words.set(
      [
        packQuadWord0(0, 0, 0, Face.PositiveZ, QuadMaterial.Solid),
        packQuadWord1(1, 1, FULL_BOX, 0),
        packQuadWord2(0x808080, 255),
      ],
      i * 3,
    );
  geometry.setAttribute("quad", new InstancedBufferAttribute(words, 3));
  if (auxiliary)
    geometry.setAttribute(
      "texture",
      new InstancedBufferAttribute(new Uint32Array(count).fill(15 << 27), 1),
    );
  geometry.instanceCount = count;
  return geometry;
}

/** Browser regression fixture: one material across changed layouts and larger buffers. */
export async function renderPooledRegions(): Promise<{ backend: string; red: number[] }> {
  const renderer = new WebGPURenderer();
  renderer.setSize(128, 128);
  document.body.append(renderer.domElement);
  await renderer.init();
  const material = new MeshBasicNodeMaterial();
  material.positionNode = quadPosition();
  material.colorNode = quadColor.mul(quadBlockLight.add(0.1));
  const pair = { steady: material, fading: material };
  const pool = new RegionMeshPool(2);
  const scene = new Scene();
  const camera = new PerspectiveCamera(45, 1, 0.1, 20);
  camera.position.set(0.5, 0.5, 4);
  camera.lookAt(0.5, 0.5, 0);
  const copy = new OffscreenCanvas(128, 128);
  const context = copy.getContext("2d")!;
  const red: number[] = [];
  try {
    // The same mesh/material used to retain a pipeline that needed a now-missing slot 3.
    for (const [count, auxiliary] of [
      [147, true],
      [161, false],
      [215, true],
      [13, false],
    ] as const) {
      const mesh = pool.acquire(pair, geometry(count, auxiliary));
      scene.add(mesh);
      renderer.render(scene, camera);
      context.drawImage(renderer.domElement, 0, 0);
      red.push(context.getImageData(64, 64, 1, 1).data[0]!);
      await new Promise((resolve) => setTimeout(resolve, 50));
      scene.remove(mesh);
      pool.release(mesh, pair);
    }
    return {
      backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? "WebGPU"
        : "WebGL 2",
      red,
    };
  } finally {
    pool.dispose();
    material.dispose();
    renderer.dispose();
  }
}
