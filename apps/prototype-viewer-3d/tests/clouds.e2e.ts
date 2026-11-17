import { expect, test } from "@playwright/test";
import type { WorldInfo, WorldViewer } from "@mapelix/viewer/three";
import type { CloudLayer } from "@mapelix/viewer/three/cloud-layer";
import type { Group } from "three/webgpu";
import type { CameraRig } from "@mapelix/viewer/three/camera-rig";

declare global {
  interface Window {
    __cloudViewer: WorldViewer;
  }
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

test("block clouds render, drift, retain their option through all contexts and dispose", async ({
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
  await page.route("**/cloud-harness", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/cloud-harness");
  await page.evaluate(async (world) => {
    const path = "/src/lib/world-viewer.ts",
      { WorldViewer } = await import(path);
    window.__cloudViewer = await WorldViewer.create(
      document.getElementById("viewer")!,
      world,
      { x: 32, y: 150, z: 16, distance: 120, heading: 0.4, pitch: 0.15 },
      { clouds: false },
    );
    window.__cloudViewer.setRenderDistance(512);
  }, worlds[0]!);
  const visible = () =>
    page.evaluate(() => (Reflect.get(window.__cloudViewer, "clouds") as CloudLayer).root.visible);
  expect(await visible()).toBe(false);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = window.__cloudViewer.snapshot().streaming;
        return stats.cached > 0 && stats.remaining === 0 && stats.loading === 0;
      }),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.__cloudViewer.setClouds(true);
    // Isolate clouds from animated lava/water when checking the rendered pixels.
    (Reflect.get(window.__cloudViewer, "streamer") as { root: Group }).root.visible = false;
  });
  await page.waitForTimeout(600);
  const enabled = await page
    .locator("canvas")
    .screenshot({ path: `test-results/${info.project.name}-clouds.png` });
  await page.waitForTimeout(700);
  const drifted = await page.locator("canvas").screenshot();
  expect(enabled.equals(drifted)).toBe(false);
  await page.evaluate(() => window.__cloudViewer.setClouds(false));
  await page.waitForTimeout(150);
  const disabled = await page.locator("canvas").screenshot();
  expect(disabled.equals(drifted)).toBe(false);
  // An overview above the cloud layer must have exactly the clear-sky pixels.
  await page.evaluate(() => {
    (Reflect.get(window.__cloudViewer, "rig") as CameraRig).setView(
      { x: 32, y: 80, z: 16, distance: 220, heading: 0.4, pitch: 0.85 },
      { settle: false },
    );
    window.__cloudViewer.setClouds(true);
  });
  await page.waitForTimeout(120);
  const aboveOn = await page.locator("canvas").screenshot();
  await page.evaluate(() => window.__cloudViewer.setClouds(false));
  await page.waitForTimeout(120);
  const aboveOff = await page.locator("canvas").screenshot();
  expect(aboveOn.equals(aboveOff)).toBe(true);
  await page.evaluate(() => {
    (Reflect.get(window.__cloudViewer, "streamer") as { root: Group }).root.visible = true;
    window.__cloudViewer.setClouds(true);
  });
  await page.waitForTimeout(550);
  await page
    .locator("canvas")
    .screenshot({ path: `test-results/${info.project.name}-clouds-world.png` });
  for (const world of worlds.slice(1)) {
    await page.evaluate((world) => {
      window.__cloudViewer.setWorld(world, true);
      window.__cloudViewer.setClouds(true);
    }, world);
    expect(await visible()).toBe(false);
  }
  await page.evaluate((world) => window.__cloudViewer.setWorld(world, true), worlds[0]!);
  expect(await visible()).toBe(true);
  const budget = await page.evaluate(() => {
    const clouds = Reflect.get(window.__cloudViewer, "clouds") as CloudLayer;
    return {
      instances: clouds.root.count,
      bytes: clouds.root.instanceMatrix.array.byteLength,
      textures: clouds.root.material.map,
    };
  });
  expect(budget.instances).toBeLessThanOrEqual(2304);
  expect(budget.bytes).toBe(147456);
  expect(budget.textures).toBeNull();
  await page.evaluate(() => window.__cloudViewer.dispose());
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the local cloud checkbox defaults on and preserves a disabled preference on reload", async ({
  page,
}) => {
  await page.goto("/?x=16&y=80&z=16&distance=120");
  const toggle = page.getByRole("checkbox", { name: "Clouds", exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible();
  await toggle.uncheck();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("mapelix-clouds-v1"))).toBe("0");
  await page.reload();
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await page.getByLabel("Dimension", { exact: true }).selectOption("nether");
  await expect(toggle).toHaveCount(0);
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible();
  await page.getByLabel("Dimension", { exact: true }).selectOption("overworld");
  await expect(toggle).not.toBeChecked();
});
