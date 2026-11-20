import { expect, test } from "@playwright/test";
import type { WorldViewer, WorldInfo } from "@mapelix/viewer/three";
import type { SelectionChange } from "@mapelix/viewer/three/selection-box";
import type { Object3D, Mesh, PerspectiveCamera } from "three/webgpu";

declare global {
  interface Window {
    __selectionViewer: WorldViewer | undefined;
    __selectionChanges: SelectionChange[];
  }
}

test("dragging a 3D selection handle commits bounds only on release and suspends camera input", async ({
  page,
  request,
}, testInfo) => {
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const world: WorldInfo = await (
    await request.get("/world.json?mode=caves&minY=-64&maxY=-32")
  ).json();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/selection-drag", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/selection-drag");
  await page.evaluate(async (world) => {
    const path = "/src/lib/world-viewer.ts";
    const { WorldViewer } = await import(path);
    window.__selectionChanges = [];
    window.__selectionViewer = await WorldViewer.create(
      document.getElementById("viewer")!,
      world,
      { x: 16, y: -48, z: 16, distance: 60, pitch: 0.8, heading: 0.4 },
      {
        selection: { minX: 0, maxX: 32, minZ: 0, maxZ: 32 },
        onSelectionChange: (change: SelectionChange) => window.__selectionChanges.push(change),
      },
    );
    window.__selectionViewer!.setSelectionTool("move");
  }, world);
  await page.waitForTimeout(800);
  const handle = (axis: string) =>
    page.evaluate((axis) => {
      const viewer = window.__selectionViewer!;
      const camera = Reflect.get(viewer, "camera") as PerspectiveCamera;
      const root = (Reflect.get(viewer, "selectionBox") as { root: Object3D }).root;
      const canvas = document.querySelector("canvas")!,
        rect = canvas.getBoundingClientRect();
      const target = root.children[0]!.position.clone().project(camera);
      const candidates: { x: number; y: number; distance: number }[] = [];
      root.updateMatrixWorld(true);
      root.traverseVisible((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh || mesh.name !== axis) return;
        mesh.geometry.computeBoundingBox();
        const point = mesh.geometry.boundingBox!.getCenter(mesh.position.clone());
        mesh.localToWorld(point).project(camera);
        candidates.push({
          x: rect.left + ((point.x + 1) * rect.width) / 2,
          y: rect.top + ((1 - point.y) * rect.height) / 2,
          distance: (point.x - target.x) ** 2 + (point.y - target.y) ** 2,
        });
      });
      candidates.sort((a, b) => b.distance - a.distance);
      return candidates[0]!;
    }, axis);
  const pointer = await handle("X");
  expect(pointer).toBeDefined();
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down();
  await page.mouse.move(pointer.x + 60, pointer.y + 10, { steps: 12 });
  expect(await page.evaluate(() => window.__selectionChanges.length)).toBe(0);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__selectionChanges.length)).toBe(1);
  const result = await page.evaluate(() => ({
    change: window.__selectionChanges[0]!,
    view: window.__selectionViewer!.snapshot().view,
  }));
  expect(result.change.selection.minX).not.toBe(0);
  expect(result.change.selection.maxX - result.change.selection.minX).toBe(32);
  expect(result.view.x).toBeCloseTo(16, 0);
  const up = await handle("Y");
  await page.mouse.move(up.x, up.y);
  await page.mouse.down();
  await page.mouse.move(up.x, up.y - 120, { steps: 12 });
  expect(await page.evaluate(() => window.__selectionChanges.length)).toBe(1);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.__selectionChanges.length)).toBe(2);
  const vertical = await page.evaluate(() => window.__selectionChanges[1]!);
  expect(vertical.minY).toBeGreaterThan(-64);
  expect(Number.isInteger(vertical.minY / 16)).toBe(true);
  await page.evaluate(() => window.__selectionViewer!.setSelectionTool("resize"));
  await page.waitForTimeout(150);
  const resize = await handle("X");
  await page.mouse.move(resize.x, resize.y);
  await page.mouse.down();
  const beforeShift = await page.evaluate(() => window.__selectionViewer!.snapshot().view.y);
  await page.keyboard.down("Shift");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__selectionViewer!.snapshot().view.y)).toBeCloseTo(
    beforeShift,
    3,
  );
  await page.mouse.move(resize.x + 45, resize.y, { steps: 12 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(() => page.evaluate(() => window.__selectionChanges.length)).toBe(3);
  const sized = await page.evaluate(() => window.__selectionChanges[2]!);
  expect(sized.selection.maxX - sized.selection.minX).not.toBe(32);
  expect(sized.selection.maxX - sized.selection.minX).toBeGreaterThanOrEqual(16);
  expect(sized.selection.maxX - sized.selection.minX).toBeLessThanOrEqual(256);
  await page.evaluate(() => {
    window.__selectionViewer!.dispose();
    window.__selectionViewer = undefined;
  });
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("cave selection clips reusable regions, exposes 3D handles and restores signed bounds", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [],
    regions: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("request", (request) => {
    if (request.url().includes("/regions/")) regions.push(request.url());
  });
  await page.goto("/?mode=caves&minY=-64&maxY=-32&x=16&y=-48&z=16&distance=60&pitch=60");
  await page.getByText("All nearby terrain loaded").waitFor();
  await page.getByText("Exploration area", { exact: false }).click();
  await page.getByRole("button", { name: "Select around view" }).click();
  await expect(page.getByRole("button", { name: "Clear area" })).toBeVisible();
  await page.getByLabel("Min X", { exact: true }).fill("-16");
  await page.getByLabel("Max X (exclusive)", { exact: true }).fill("32");
  await page.getByLabel("Min Z", { exact: true }).fill("0");
  await page.getByLabel("Max Z (exclusive)", { exact: true }).fill("32");
  await page.getByRole("button", { name: "Apply area" }).click();
  await expect(page).toHaveURL(/minX=-16/);
  await page.getByLabel("3D box", { exact: true }).selectOption("move");
  await page.waitForTimeout(600);
  await page.getByLabel("3D box", { exact: true }).selectOption("resize");
  await page.waitForTimeout(600);
  await expect(page.locator("canvas")).toHaveCount(1);
  expect(regions.every((url) => !new URL(url).searchParams.has("minX"))).toBe(true);
  await page.reload();
  await page.getByText("Exploration area", { exact: false }).click();
  await expect(page.getByLabel("Min X", { exact: true })).toHaveValue("-16");
  await page.getByRole("button", { name: "Clear area" }).click();
  await expect(page).not.toHaveURL(/minX=/);
  expect(errors).toEqual([]);
});
