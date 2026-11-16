import { expect, it, vi } from "vitest";
import { Vector3 } from "three/webgpu";
import { sceneContext } from "@mapelix/scene-prototype/dimensions";
import { Atmosphere } from "./atmosphere";
import { MAX_RAIN_DROPS, WeatherLayer, weatherMode } from "./weather-layer";

const camera = new Vector3(8, 100, 8);
it("defaults to clear and validates host mode values", () => {
  const sky = new Atmosphere(),
    layer = new WeatherLayer(sky);
  layer.update(1 / 60, 1 / 60, camera, 1, () => 80);
  expect(layer.root.visible).toBe(false);
  expect(sky.rain.value).toBe(0);
  expect(() => weatherMode("snow")).toThrow(RangeError);
  layer.dispose();
});

it("bounds particles, reuses buffers and samples loaded roofs only when needed", () => {
  const sky = new Atmosphere(),
    layer = new WeatherLayer(sky, "rain"),
    roof = vi.fn(() => 85);
  const geometry = layer.root.geometry,
    bytes = Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0);
  for (let i = 0; i < 120; i++) layer.update(1 / 60, 1 / 60, camera, 1, roof);
  expect(sky.rain.value).toBeGreaterThan(0.9);
  expect(geometry.drawRange.count).toBe(MAX_RAIN_DROPS * 2);
  expect(roof).toHaveBeenCalledTimes(MAX_RAIN_DROPS);
  expect(Array.from(geometry.getAttribute("rainRoof").array).every((y) => y === 85)).toBe(true);
  layer.update(1 / 60, 1 / 60, camera, 2, roof);
  expect(roof).toHaveBeenCalledTimes(MAX_RAIN_DROPS * 2);
  for (let i = 0; i < 30; i++)
    layer.update(1 / 60, 1 / 60, new Vector3(i * 1000, 100, -i * 1000), i + 3, roof);
  expect(layer.root.geometry).toBe(geometry);
  expect(Object.values(geometry.attributes).reduce((n, a) => n + a.array.byteLength, 0)).toBe(
    bytes,
  );
  layer.dispose();
});

it("clears fog, wetness and flashes outside Overworld Surface while retaining the choice", () => {
  const sky = new Atmosphere(),
    layer = new WeatherLayer(sky, "thunderstorm");
  let flash = 0;
  for (let i = 0; i < 16 * 60; i++) {
    layer.update(1 / 60, 1 / 60, camera, 1, () => 80);
    flash = Math.max(flash, sky.lightning.value);
  }
  expect(flash).toBeGreaterThan(0);
  expect(flash).toBeLessThanOrEqual(0.35);
  expect(sky.storm.value).toBeGreaterThan(0.99);
  for (const context of [
    sceneContext("nether"),
    sceneContext("the-end"),
    sceneContext("overworld", { mode: "caves" }),
  ]) {
    layer.setContext(context);
    layer.update(1 / 60, 1 / 60, camera, 1, () => 80);
    expect(layer.root.visible).toBe(false);
    expect([sky.rain.value, sky.storm.value, sky.lightning.value]).toEqual([0, 0, 0]);
  }
  layer.setContext(sceneContext());
  layer.update(1 / 60, 1 / 60, camera, 1, () => 80);
  expect(sky.rain.value).toBeGreaterThan(0);
  layer.setMode("clear");
  for (let i = 0; i < 600; i++) layer.update(1 / 60, 1 / 60, camera, 1, () => 80);
  expect(layer.root.visible).toBe(false);
  expect(sky.rain.value).toBe(0);
  layer.dispose();
});

it("automatically suppresses cosmetic effects on sustained low frame rates", () => {
  const sky = new Atmosphere(),
    layer = new WeatherLayer(sky, "thunderstorm");
  for (let i = 0; i < 40; i++) layer.update(0.1, 0.1, camera, 1, () => 80);
  expect(layer.budget.quality).toBe(0);
  expect(layer.root.visible).toBe(false);
  expect([sky.rain.value, sky.storm.value, sky.lightning.value]).toEqual([0, 0, 0]);
  const disposed = vi.fn();
  layer.root.geometry.addEventListener("dispose", disposed);
  layer.root.material.addEventListener("dispose", disposed);
  layer.dispose();
  expect(disposed).toHaveBeenCalledTimes(2);
});

it("keeps the perspective rain volume and grows it to cover an isometric view", () => {
  const spread = (scale?: number) => {
    const sky = new Atmosphere(),
      layer = new WeatherLayer(sky, "rain"),
      xs: number[] = [];
    for (let i = 0; i < 120; i++)
      layer.update(1 / 60, 1 / 60, camera, 1, (x) => (xs.push(x - camera.x), 80), scale);
    const offsets = xs.slice(-MAX_RAIN_DROPS);
    layer.dispose();
    return { min: Math.min(...offsets), max: Math.max(...offsets), offsets };
  };
  const perspective = spread(),
    explicit = spread(1),
    isometric = spread(6);
  // Scale 1 is exactly the perspective volume.
  expect(explicit.offsets).toEqual(perspective.offsets);
  expect(perspective.min).toBeGreaterThanOrEqual(-32);
  expect(perspective.max).toBeLessThanOrEqual(32);
  // A larger volume spreads the same drops over the visible ground.
  expect(isometric.min).toBeLessThan(-150);
  expect(isometric.max).toBeGreaterThan(150);
  expect(isometric.max).toBeLessThanOrEqual(192);
});
