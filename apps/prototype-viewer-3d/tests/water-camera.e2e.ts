import { expect, test, type Page } from "@playwright/test";
import type { WorldViewer, WorldInfo, CameraView, WorldViewerOptions } from "@mapelix/viewer/three";
import type { SceneMaterials } from "@mapelix/viewer/three/shaders/materials";
import type { CloudLayer } from "@mapelix/viewer/three/cloud-layer";
import type { WeatherLayer } from "@mapelix/viewer/three/weather-layer";
import type { Scene, Mesh, WebGPURenderer } from "three/webgpu";

declare global {
  interface Window {
    __waterViewer: WorldViewer;
    __surfaceDraws: string[];
  }
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

async function harness(
  page: Page,
  world: WorldInfo,
  view: CameraView,
  options: WorldViewerOptions = { clouds: true, weather: "rain" },
) {
  await page.route("**/surface-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/surface-regression");
  await page.evaluate(
    async ({ world, view, options }) => {
      const path = "/src/lib/world-viewer.ts",
        { WorldViewer } = await import(path);
      window.__waterViewer = await WorldViewer.create(
        document.getElementById("viewer")!,
        world,
        view,
        options,
      );
      window.__waterViewer.setRenderDistance(512);
    },
    { world, view, options },
  );
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__waterViewer.snapshot().streaming;
        return s.cached > 0 && s.quads > 0 && !s.remaining && !s.loading;
      }),
    )
    .toBe(true);
  await page.waitForTimeout(450);
}

test("clear weather retains the original underwater bed and waves at close range", async ({
  page,
  request,
}, info) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(
    page,
    world,
    { x: 80, y: 84, z: 16, distance: 45, pitch: 1, heading: 0.4 },
    { clouds: false, weather: "clear" },
  );
  await page
    .locator("canvas")
    .screenshot({ path: `test-results/${info.project.name}-clear-water-closeup.png` });
  await page.evaluate(() => window.__waterViewer.dispose());
});

test("water captures terrain before clouds and rain without losing its refraction", async ({
  page,
  request,
}, info) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(page, world, { x: 80, y: 84, z: 16, distance: 180, pitch: 1.1, heading: 0.4 });
  const order = await page.evaluate(async () => {
    const viewer = window.__waterViewer,
      renderer = Reflect.get(viewer, "renderer") as WebGPURenderer,
      scene = Reflect.get(viewer, "scene") as Scene,
      materials = Reflect.get(viewer, "materials") as SceneMaterials,
      clouds = (Reflect.get(viewer, "clouds") as CloudLayer).root,
      rain = (Reflect.get(viewer, "weather") as WeatherLayer).root;
    window.__surfaceDraws = [];
    return await new Promise<string[]>((resolve) => {
      let scheduled = false;
      scene.traverse((object) => {
        const mesh = object as Mesh,
          m = mesh.material;
        const kind =
          object === clouds
            ? "clouds"
            : object === rain
              ? "rain"
              : m === materials.water.steady || m === materials.water.fading
                ? "water"
                : undefined;
        if (!kind) return;
        const before = object.onBeforeRender;
        object.onBeforeRender = function (...args) {
          window.__surfaceDraws.push(kind);
          if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
              renderer.setAnimationLoop(null);
              resolve([...window.__surfaceDraws]);
            });
          }
          before.apply(this, args);
        };
      });
    });
  });
  await page
    .locator("canvas")
    .screenshot({ path: `test-results/${info.project.name}-surface-water.png` });
  expect(order).toContain("water");
  expect(order).toContain("clouds");
  expect(order).toContain("rain");
  expect(order.lastIndexOf("water")).toBeLessThan(order.indexOf("clouds"));
  expect(order.lastIndexOf("water")).toBeLessThan(order.indexOf("rain"));
  await page.evaluate(() => window.__waterViewer.dispose());
});

test("a plain click never retargets onto a distant surface or changes camera altitude", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  const view = { x: 16, y: 120, z: 288, distance: 60, pitch: 0.15, heading: 0 };
  await harness(page, world, view);
  const before = await page.evaluate(() => window.__waterViewer.snapshot().view);
  await page.mouse.click(400, 300);
  await page.waitForTimeout(100);
  const after = await page.evaluate(() => window.__waterViewer.snapshot().view);
  for (const key of ["x", "y", "z", "distance", "heading", "pitch"] as const)
    expect(after[key]).toBeCloseTo(before[key], 3);
  // Dragging and scrolling over the sky must not promote a distant shore to the pivot.
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(410, 300, { steps: 5 });
  await page.mouse.up();
  expect((await page.evaluate(() => window.__waterViewer.snapshot().view)).distance).toBeLessThan(
    120,
  );
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(100);
  expect((await page.evaluate(() => window.__waterViewer.snapshot().view)).distance).toBeLessThan(
    120,
  );
  // Cosmetic switches also leave the pose untouched.
  const toggled = await page.evaluate(() => {
    const v = window.__waterViewer,
      before = v.snapshot().view;
    v.setClouds(false);
    v.setWeather("clear");
    return { before, after: v.snapshot().view };
  });
  expect(toggled.after).toEqual(toggled.before);
  await page.evaluate(() => window.__waterViewer.dispose());
});
