import { Mesh, NeutralToneMapping, OrthographicCamera, Scene, WebGPURenderer } from "three/webgpu";
import { Atmosphere } from "@mapelix/viewer/three/atmosphere";
import { BlockAtlas } from "@mapelix/viewer/three/block-atlas";
import { RegionMesh } from "@mapelix/viewer/three/region-mesh";
import {
  createSceneMaterials,
  createTexturedMaterials,
} from "@mapelix/viewer/three/shaders/materials";
import { TextureLook } from "@mapelix/viewer/three/shaders/textured";
import {
  Face,
  FULL_BOX,
  QuadMaterial,
  decodeSceneRegion,
  encodeSceneRegion,
  packQuadWord0,
  packQuadWord1,
  packQuadWord2,
} from "@mapelix/scene-prototype/format";
import { packQuadTexture } from "@mapelix/scene-prototype/texture-format";

const COLORS = [0xb88b4a, 0x888888, 0xb02e26, 0x5e7c16, 0x3c44aa, 0xe0e0e0];

/** Real terrain shaders, isolated from sky/bloom: material colors and contact occlusion. */
export async function sampleBlockLightAppearance() {
  const renderer = new WebGPURenderer();
  renderer.setSize(1200, 100);
  renderer.toneMapping = NeutralToneMapping;
  document.body.append(renderer.domElement);
  await renderer.init();
  const atmosphere = new Atmosphere();
  atmosphere.daylight.value = 0;
  const plain = createSceneMaterials(atmosphere);
  // Original flat test textures. Tile gutters and mipmaps hold the same color.
  const atlas = new BlockAtlas({
    tileSize: 16,
    columns: COLORS.length,
    rows: 1,
    tiles: COLORS.map((average) => ({ average, frames: 1, ticksPerFrame: 1, coverage: 255 })),
    levels: [24, 12, 6].map((size) => {
      const pixels = new Uint8Array(size * size * COLORS.length * 4);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size * COLORS.length; x++) {
          const value = COLORS[Math.floor(x / size)]!;
          pixels.set(
            [value >> 16, (value >> 8) & 255, value & 255, 255],
            (y * size * COLORS.length + x) * 4,
          );
        }
      return pixels;
    }),
  });
  const look = new TextureLook(atlas);
  look.setFade({ none: 1, full: 2 });
  look.viewHeight.value = 100;
  const textured = createTexturedMaterials(atmosphere, plain, look);
  const camera = new OrthographicCamera(0, 12, 1, 0, 0.1, 20);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  const scene = new Scene();
  const copy = new OffscreenCanvas(1200, 100);
  const context = copy.getContext("2d")!;
  const rows = [];
  try {
    for (const mode of ["plain", "textured"] as const) {
      const quads: number[] = [];
      const textures: number[] = [];
      for (const [index, color] of COLORS.entries()) {
        quads.push(
          packQuadWord0(index * 2, 0, 0, Face.PositiveZ, QuadMaterial.Solid),
          packQuadWord1(1, 1, FULL_BOX, 0),
          packQuadWord2(color, 0),
        );
        textures.push(packQuadTexture(index, 0, false));
      }
      const empty = new Uint32Array(0);
      const region = decodeSceneRegion(
        encodeSceneRegion({
          level: 0,
          x: 0,
          z: 0,
          minY: 0,
          maxY: 1,
          heights: new Int16Array(64 * 64),
          opaque: Uint32Array.from(quads),
          plants: empty,
          translucent: empty,
          blockLight: {
            opaque: new Uint8Array(COLORS.length).fill(15),
            plants: new Uint8Array(),
            translucent: new Uint8Array(),
          },
          ...(mode === "textured"
            ? {
                textures: { opaque: Uint32Array.from(textures), plants: empty, translucent: empty },
              }
            : {}),
        }),
      );
      const mesh = new RegionMesh(region, mode === "plain" ? plain : textured);
      scene.add(mesh.group);
      const swatches = COLORS.map((color) => ({ color, occlusion: [] as number[][] }));
      // Change only occlusion at the same world positions: procedural color noise stays fixed.
      for (const level of [0, 1, 2, 3]) {
        for (const [index, color] of COLORS.entries())
          region.opaque[index * 3 + 2] = packQuadWord2(color, level * 0x55);
        mesh.group.traverse((object) => {
          if (object instanceof Mesh) object.geometry.getAttribute("quad").needsUpdate = true;
        });
        renderer.render(scene, camera);
        context.drawImage(renderer.domElement, 0, 0);
        for (const [index, swatch] of swatches.entries())
          swatch.occlusion.push(
            Array.from(context.getImageData(index * 200 + 50, 50, 1, 1).data).slice(0, 3),
          );
      }
      rows.push({ mode, swatches });
      scene.remove(mesh.group);
      mesh.dispose();
    }
    return {
      backend: (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
        ? "WebGPU"
        : "WebGL 2",
      rows,
    };
  } finally {
    for (const material of new Set(
      [...Object.values(plain), ...Object.values(textured)].flatMap((pair) => [
        pair.steady,
        pair.fading,
      ]),
    ))
      material.dispose();
    atlas.dispose();
    renderer.dispose();
  }
}
