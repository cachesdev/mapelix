import { expect, test, type Page } from "@playwright/test";
import type { PerspectiveCamera } from "three/webgpu";
import type { DiscoveryGroup } from "@mapelix/scene-prototype/discoveries";
import type { WorldInfo, WorldViewer, WorldViewerOptions } from "@mapelix/viewer/three";

declare global {
  interface Window {
    __labelViewer: WorldViewer;
    __labelClicks: DiscoveryGroup[];
  }
}

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

async function harness(page: Page, world: WorldInfo) {
  await page.route("**/label-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:640px;height:400px"></div></body></html>',
    }),
  );
  await page.goto("/label-harness");
  await page.evaluate(async (world) => {
    const path = "/src/lib/world-viewer.ts",
      { WorldViewer } = await import(path);
    window.__labelClicks = [];
    window.__labelViewer = await WorldViewer.create(
      document.getElementById("viewer")!,
      world,
      { x: 40, y: 82, z: 8, distance: 60, heading: 0.4, pitch: 0.9 },
      {
        discoveryFilters: {
          enabled: true,
          categories: ["containers"],
          ores: [],
          exposure: "all",
          allHeights: false,
        },
        formatDiscoveryLabel: (group, kind) => `Host ${kind.label} ×${group.count} · Y ${group.y}`,
        onDiscoverySelect: (group) => {
          window.__labelClicks.push(group);
          void window.__labelViewer.focusDiscovery(group);
        },
      } satisfies WorldViewerOptions,
    );
    window.__labelViewer.setRenderDistance(128);
  }, world);
  await expect(
    page.getByRole("button", { name: "Host Chest ×2 · Y 81", exact: true }),
  ).toBeVisible();
}

test("a host-formatted label appears synchronously on hover and keyboard focus and follows the marker within the canvas", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(page, world);
  const marker = page.getByRole("button", { name: "Host Chest ×2 · Y 81", exact: true }),
    label = page.locator("[data-discovery-label]");
  await marker.hover();
  const immediate = await marker.evaluate((button) => {
    button.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "mouse" }));
    button.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    const label = document.querySelector<HTMLElement>("[data-discovery-label]")!;
    return { hidden: label.hidden, text: label.textContent, title: button.getAttribute("title") };
  });
  expect(immediate).toEqual({ hidden: false, text: "Host Chest ×2 · Y 81", title: null });
  await expect(label).toHaveCount(1);
  await page.mouse.move(1100, 750);
  await expect(label).toBeHidden();
  await page.locator("canvas").focus();
  await page.keyboard.press("Tab");
  await expect(marker).toBeFocused();
  await expect(label).toBeVisible();
  const before = (await label.boundingBox())!;
  await marker.evaluate((button) => {
    const rect = document.querySelector("canvas")!.getBoundingClientRect(),
      b = button.getBoundingClientRect();
    const camera = Reflect.get(window.__labelViewer, "camera") as PerspectiveCamera;
    camera.setViewOffset(
      rect.width,
      rect.height,
      b.left + b.width / 2 - rect.left - 12,
      b.top + b.height / 2 - rect.top - 14,
      rect.width,
      rect.height,
    );
  });
  await expect.poll(async () => (await marker.boundingBox())!.y).toBeLessThan(20);
  await expect(label).toBeVisible();
  const after = (await label.boundingBox())!,
    button = (await marker.boundingBox())!,
    canvas = (await page.locator("canvas").boundingBox())!;
  expect(after.y).not.toBeCloseTo(before.y, 0);
  expect(after.y).toBeGreaterThanOrEqual(button.y + button.height);
  expect(after.x).toBeGreaterThanOrEqual(canvas.x);
  expect(after.y + after.height).toBeLessThanOrEqual(canvas.y + canvas.height);
  expect(after.x + after.width).toBeLessThanOrEqual(canvas.x + canvas.width);
  await page.locator("canvas").focus();
  await expect(label).toBeHidden();
  await page.evaluate(() => window.__labelViewer.dispose());
});

test("labels never intercept map clicks or drags and clean up on hidden markers, view changes and disposal", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(page, world);
  const marker = page.getByRole("button", { name: "Host Chest ×2 · Y 81", exact: true }),
    label = page.locator("[data-discovery-label]");
  await marker.hover();
  await expect(label).toBeVisible();
  expect(
    await label.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.tagName;
    }),
  ).toBe("CANVAS");
  const bounds = (await label.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  expect(await page.evaluate(() => window.__labelClicks.length)).toBe(0);
  await marker.hover();
  const drag = (await label.boundingBox())!,
    before = await page.evaluate(() => window.__labelViewer.snapshot().view);
  await page.mouse.move(drag.x + drag.width / 2, drag.y + drag.height / 2);
  await page.mouse.down();
  await page.mouse.move(drag.x + drag.width / 2 + 40, drag.y + drag.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => window.__labelViewer.snapshot().view);
  expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(0.1);
  expect(await page.evaluate(() => window.__labelClicks.length)).toBe(0);
  await marker.focus();
  await expect(label).toBeVisible();
  await page.evaluate(() => {
    const camera = Reflect.get(window.__labelViewer, "camera") as PerspectiveCamera;
    camera.setViewOffset(640, 400, 6400, 0, 640, 400);
  });
  await expect(marker).toBeHidden();
  await expect(label).toBeHidden();
  await page.evaluate(() =>
    (Reflect.get(window.__labelViewer, "camera") as PerspectiveCamera).clearViewOffset(),
  );
  await expect(marker).toBeVisible();
  await marker.hover();
  await expect(label).toBeVisible();
  expect(
    await page.evaluate((world) => {
      window.__labelViewer.setWorld(
        { ...world, mode: "caves", minY: -64, maxY: -32, ceilingY: -32 },
        true,
      );
      return document.querySelector<HTMLElement>("[data-discovery-label]")!.hidden;
    }, world),
  ).toBe(true);
  await page.evaluate((world) => {
    window.__labelViewer.setWorld(world, false);
    window.__labelViewer.focusOn({ x: 40, y: 81, z: 8 });
  }, world);
  await expect(marker).toBeVisible();
  await marker.hover();
  await expect(label).toBeVisible();
  await page.evaluate(() => window.__labelViewer.dispose());
  await expect(label).toHaveCount(0);
  await expect(page.locator('[aria-label="Discovery markers"]')).toHaveCount(0);
});

test("a touch tap opens the discovery card without a hover or focus bubble", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await harness(page, world);
  const marker = page.getByRole("button", { name: "Host Chest ×2 · Y 81", exact: true }),
    label = page.locator("[data-discovery-label]");
  const b = (await marker.boundingBox())!,
    cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }],
  });
  await expect(label).toBeHidden();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await expect.poll(() => page.evaluate(() => window.__labelClicks.length)).toBe(1);
  await expect(label).toBeHidden();
  await expect(page.locator("[data-discovery-details]")).toBeVisible();
  await page.evaluate(() => window.__labelViewer.dispose());
});
