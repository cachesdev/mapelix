import { expect, test } from "@playwright/test";
import type { PerspectiveCamera } from "three/webgpu";
import type { WorldViewer, WorldInfo } from "@mapelix/viewer/three";
import type { WeatherLayer } from "@mapelix/viewer/three/weather-layer";
import type { Atmosphere } from "@mapelix/viewer/three/atmosphere";

declare global {
  interface Window {
    __weatherViewer: WorldViewer;
  }
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

test("cosmetic rain and storm fog render, use bounded buffers, adapt to low FPS and suspend outside Overworld Surface", async ({
  page,
  request,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (e) => {
    if (e.type() === "error") errors.push(e.text());
  });
  const worlds: WorldInfo[] = [];
  for (const context of [
    "",
    "?mode=caves&minY=-64&maxY=-32",
    "?dimension=nether",
    "?dimension=the-end",
  ])
    worlds.push(await (await request.get(`/world.json${context}`)).json());
  await page.route("**/weather-harness", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/weather-harness");
  await page.evaluate(async (world) => {
    const path = "/src/lib/world-viewer.ts",
      { WorldViewer } = await import(path);
    window.__weatherViewer = await WorldViewer.create(
      document.getElementById("viewer")!,
      world,
      { x: 32, y: 81, z: 16, distance: 70, heading: 0.4, pitch: 0.7 },
      { clouds: false },
    );
    window.__weatherViewer.setRenderDistance(256);
  }, worlds[0]!);
  const state = () =>
    page.evaluate(() => {
      const sky = Reflect.get(window.__weatherViewer, "atmosphere") as Atmosphere,
        rain = Reflect.get(window.__weatherViewer, "weather") as WeatherLayer;
      return {
        rain: sky.rain.value,
        storm: sky.storm.value,
        flash: sky.lightning.value,
        visible: rain.root.visible,
        count: rain.root.geometry.drawRange.count,
        quality: rain.budget.quality,
      };
    });
  expect(await state()).toMatchObject({ rain: 0, storm: 0, visible: false });
  await expect
    .poll(() => page.evaluate(() => window.__weatherViewer.snapshot().streaming.remaining))
    .toBe(0);
  await page.waitForTimeout(350);
  const clear = await page.locator("canvas").screenshot();
  await page.evaluate(() => window.__weatherViewer.setWeather("rain"));
  await expect.poll(async () => (await state()).rain).toBeGreaterThan(0.8);
  const wet = await page
    .locator("canvas")
    .screenshot({ path: `test-results/${info.project.name}-rain.png` });
  expect(wet.equals(clear)).toBe(false);
  expect((await state()).count).toBeLessThanOrEqual(2048);
  await page.evaluate(() => window.__weatherViewer.setWeather("thunderstorm"));
  await expect.poll(async () => (await state()).storm).toBeGreaterThan(0.8);
  await page.locator("canvas").screenshot({ path: `test-results/${info.project.name}-storm.png` });
  await page.evaluate(() => {
    const rain = Reflect.get(window.__weatherViewer, "weather") as WeatherLayer,
      camera = Reflect.get(window.__weatherViewer, "camera") as PerspectiveCamera;
    for (let i = 0; i < 60; i++) rain.update(0.1, 0.1, camera.position, 1, () => 80);
  });
  expect(await state()).toMatchObject({ quality: 0, rain: 0, storm: 0, flash: 0, visible: false });
  for (const world of worlds.slice(1)) {
    await page.evaluate((world) => window.__weatherViewer.setWorld(world, true), world);
    expect(await state()).toMatchObject({ rain: 0, storm: 0, flash: 0, visible: false });
  }
  await page.evaluate((world) => {
    window.__weatherViewer.setWorld(world, true);
    const rain = Reflect.get(window.__weatherViewer, "weather") as WeatherLayer,
      camera = Reflect.get(window.__weatherViewer, "camera") as PerspectiveCamera;
    for (let i = 0; i < 1500; i++) rain.update(1 / 60, 1 / 60, camera.position, 1, () => 80);
  }, worlds[0]!);
  expect((await state()).rain).toBeGreaterThan(0.8);
  await page.evaluate(() => window.__weatherViewer.dispose());
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("weather controls default off, retain the chosen mode and appear only in Overworld Surface", async ({
  page,
}) => {
  await page.goto("/?x=32&y=81&z=16&distance=70");
  const rain = page.getByRole("checkbox", { name: "Rain", exact: true }),
    storm = page.getByRole("checkbox", { name: "Thunderstorm", exact: true });
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible();
  await expect(rain).not.toBeChecked();
  await expect(storm).toBeDisabled();
  await rain.check();
  await storm.check();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("mapelix-weather-v1")))
    .toBe("thunderstorm");
  await page.reload();
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible();
  await expect(rain).toBeChecked();
  await expect(storm).toBeChecked();
  await page.getByLabel("View", { exact: true }).selectOption("caves");
  await expect(rain).toHaveCount(0);
  await page.getByLabel("View", { exact: true }).selectOption("surface");
  await expect(rain).toBeChecked();
  await page.getByLabel("Dimension", { exact: true }).selectOption("nether");
  await expect(rain).toHaveCount(0);
});
