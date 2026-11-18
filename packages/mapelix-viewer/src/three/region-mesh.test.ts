import { expect, it } from "vitest";
import { Mesh, MeshBasicNodeMaterial } from "three/webgpu";
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
import {
  QUAD_BLOCK_LIGHT_SHIFT,
  QUAD_CUTOUT,
  packQuadTexture,
  unpackQuadTexture,
  withTextureOffset,
} from "@mapelix/scene-prototype/texture-format";
import { RegionMesh } from "./region-mesh";
import type { SceneMaterials } from "./shaders/materials";

const material = new MeshBasicNodeMaterial();
const pair = { steady: material, fading: material };
const materials: SceneMaterials = {
  terrain: pair,
  lava: pair,
  water: pair,
  glass: pair,
  plants: pair,
};
const quad = (kind: QuadMaterial) =>
  Uint32Array.of(
    packQuadWord0(0, 0, 0, Face.PositiveY, kind),
    packQuadWord1(1, 1, FULL_BOX, 0),
    packQuadWord2(0x808080, 255),
  );

it.each([false, true])(
  "packs GPU light without touching texture flags or source buffers, textured=%s",
  (textured) => {
    const word = withTextureOffset(packQuadTexture(1234, 3, true) | QUAD_CUTOUT, 15, 15);
    const empty = new Uint32Array(0);
    const region = decodeSceneRegion(
      encodeSceneRegion({
        level: 0,
        x: 0,
        z: 0,
        minY: 0,
        maxY: 1,
        heights: new Int16Array(4096),
        opaque: quad(QuadMaterial.Solid),
        plants: empty,
        translucent: empty,
        blockLight: {
          opaque: Uint8Array.of(15),
          plants: new Uint8Array(0),
          translucent: new Uint8Array(0),
        },
        ...(textured
          ? { textures: { opaque: Uint32Array.of(word), plants: empty, translucent: empty } }
          : {}),
      }),
    );
    const mesh = new RegionMesh(region, materials);
    const layer = mesh.group.children[0] as Mesh;
    const gpu = layer.geometry.getAttribute("texture").array[0]!;
    expect((gpu >>> QUAD_BLOCK_LIGHT_SHIFT) & 15).toBe(15);
    expect(unpackQuadTexture(gpu)).toEqual(textured ? unpackQuadTexture(word) : undefined);
    if (textured) expect(region.textures!.opaque[0]).toBe(word);
    expect(mesh.quadCount).toBe(1);
    expect(mesh.byteLength).toBe(16);
    mesh.dispose();
  },
);

it("keeps light paired with glass and water when splitting the translucent stream", () => {
  const region = decodeSceneRegion(
    encodeSceneRegion({
      level: 0,
      x: 0,
      z: 0,
      minY: 0,
      maxY: 1,
      heights: new Int16Array(4096),
      opaque: new Uint32Array(0),
      plants: new Uint32Array(0),
      translucent: Uint32Array.from([...quad(QuadMaterial.Glass), ...quad(QuadMaterial.Water)]),
      blockLight: {
        opaque: new Uint8Array(0),
        plants: new Uint8Array(0),
        translucent: Uint8Array.of(7, 14),
      },
    }),
  );
  const mesh = new RegionMesh(region, materials);
  expect(
    mesh.group.children.map(
      (child) =>
        ((child as Mesh).geometry.getAttribute("texture").array[0]! >>> QUAD_BLOCK_LIGHT_SHIFT) &
        15,
    ),
  ).toEqual([14, 7]);
  mesh.dispose();
});

it("allocates no auxiliary GPU buffer for unlit and distant geometry", () => {
  const region = decodeSceneRegion(
    encodeSceneRegion({
      level: 0,
      x: 0,
      z: 0,
      minY: 0,
      maxY: 1,
      heights: new Int16Array(4096),
      opaque: Uint32Array.from([...quad(QuadMaterial.Solid), ...quad(QuadMaterial.Solid)]),
      plants: new Uint32Array(0),
      translucent: new Uint32Array(0),
    }),
  );
  const mesh = new RegionMesh(region, materials);
  expect((mesh.group.children[0] as Mesh).geometry.getAttribute("texture")).toBeUndefined();
  expect(mesh.quadCount).toBe(2);
  expect(mesh.byteLength).toBe(24);
  mesh.dispose();
});
