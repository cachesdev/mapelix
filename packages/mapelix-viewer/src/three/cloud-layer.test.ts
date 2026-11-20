import { expect, it, vi } from "vitest";
import { Vector3 } from "three/webgpu";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import { Atmosphere } from "./atmosphere";
import { CloudLayer, cloudCell } from "./cloud-layer";

it("keeps a stable repeating cloud field at positive and negative coordinates", () => {
  let occupied = 0;
  for (let z = -24; z < 24; z++)
    for (let x = -24; x < 24; x++) {
      expect(cloudCell(x + 16384, z - 16384)).toBe(cloudCell(x, z));
      occupied += Number(cloudCell(x, z));
    }
  expect(occupied).toBeGreaterThan(100);
  expect(occupied).toBeLessThan(2000);
});

it("drifts without uploading instance matrices every frame and bounds distant exploration", () => {
  const layer = new CloudLayer(new Atmosphere()),
    camera = new Vector3(8, 100, 8);
  layer.update(0, camera);
  const version = layer.root.instanceMatrix.version,
    x = layer.root.position.x,
    bytes = layer.root.instanceMatrix.array.byteLength;
  layer.update(0.1, camera);
  expect(layer.root.position.x).toBeCloseTo(x + 0.07);
  expect(layer.root.instanceMatrix.version).toBe(version);
  for (let i = 0; i < 30; i++) {
    layer.update(0.1, camera.set(-1_000_000 + i * 1000, 100, 1_000_000));
    expect(layer.root.count).toBeGreaterThan(0);
    expect(layer.root.count).toBeLessThanOrEqual(48 * 48);
    expect(layer.root.instanceMatrix.array.byteLength).toBe(bytes);
  }
  layer.dispose();
});

it("retains the toggle while other dimensions and Caves hide the layer", () => {
  const layer = new CloudLayer(new Atmosphere());
  for (const context of [
    sceneContext("nether"),
    sceneContext("the-end"),
    sceneContext("overworld", { mode: "caves" }),
  ]) {
    layer.setContext(context);
    expect(layer.root.visible).toBe(false);
  }
  layer.setContext(sceneContext());
  expect(layer.root.visible).toBe(true);
  layer.setEnabled(false);
  layer.setContext(sceneContext());
  expect(layer.root.visible).toBe(false);
  const geometry = vi.fn(),
    material = vi.fn(),
    instances = vi.fn();
  layer.root.geometry.addEventListener("dispose", geometry);
  layer.root.material.addEventListener("dispose", material);
  layer.root.addEventListener("dispose", instances);
  layer.dispose();
  expect(geometry).toHaveBeenCalledOnce();
  expect(material).toHaveBeenCalledOnce();
  expect(instances).toHaveBeenCalledOnce();
});
