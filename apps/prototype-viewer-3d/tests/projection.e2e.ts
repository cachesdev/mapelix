import { expect, test, type Page } from "@playwright/test";
import type { CameraView, WorldInfo, WorldViewer, WorldViewerOptions } from "@mapelix/viewer/three";

declare global {
  interface Window {
    __projectionViewer: WorldViewer | undefined;
  }
}

interface Still {
  /** SHA-256 of every RGBA pixel. */
  readonly digest: string;
  /** Luminance on a grid over the middle of the canvas, where the pool is. */
  readonly lumas: number[];
  /** Mean blue minus mean red over the same grid. */
  readonly blueness: number;
}

/** Above the fixture pool: three blocks of water over a red and white checkerboard. */
const POOL: CameraView = { x: 80, y: 81, z: 16, distance: 40, heading: 0.4, pitch: 0.9 };
const OPTIONS: WorldViewerOptions = { clouds: false, weather: "clear" };

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.route("**/projection-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/projection-regression");
});

async function open(page: Page, world: WorldInfo, view: CameraView): Promise<void> {
  await page.evaluate(
    async ({ world, view, options }) => {
      window.__projectionViewer?.dispose();
      const path = "/src/lib/world-viewer.ts",
        { WorldViewer } = await import(path);
      const element = document.getElementById("viewer")!;
      element.replaceChildren();
      const viewer: WorldViewer = await WorldViewer.create(element, world, view, options);
      viewer.setRenderDistance(512);
      window.__projectionViewer = viewer;
    },
    { world, view, options: OPTIONS },
  );
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__projectionViewer!.snapshot().streaming;
        return s.cached > 0 && s.quads > 0 && !s.remaining && !s.loading;
      }),
    )
    .toBe(true);
  // Region dissolves and the shadow refresh finish.
  await page.waitForTimeout(1000);
}

/**
 * Stops the render loop and draws one frame with the animation clock fixed, so water waves
 * match between views, then reads the pixels back.
 */
async function still(page: Page, hideWater = false): Promise<Still> {
  return page.evaluate(async (hideWater) => {
    const viewer = window.__projectionViewer!;
    const renderer = Reflect.get(viewer, "renderer") as {
      domElement: HTMLCanvasElement;
      setAnimationLoop(loop: null): void;
      _nodes: { nodeFrame: { lastTime: number; time: number } };
    };
    const pipeline = Reflect.get(viewer, "pipeline") as { render(): void };
    const water = (Reflect.get(viewer, "materials") as Record<string, Record<string, object>>)
      .water!;
    renderer.setAnimationLoop(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const material of Object.values(water)) Reflect.set(material, "visible", !hideWater);
    const canvas = renderer.domElement;
    const copy = new OffscreenCanvas(canvas.width, canvas.height);
    const context = copy.getContext("2d")!;
    const now = performance.now(),
      clock = performance.now;
    performance.now = () => now;
    try {
      renderer._nodes.nodeFrame.lastTime = now;
      renderer._nodes.nodeFrame.time = 7.25;
      pipeline.render();
      context.drawImage(canvas, 0, 0);
    } finally {
      performance.now = clock;
      for (const material of Object.values(water)) Reflect.set(material, "visible", true);
    }
    const { data, width, height } = context.getImageData(0, 0, copy.width, copy.height);
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const lumas: number[] = [];
    let blueness = 0;
    for (let row = 0; row < 24; row += 1)
      for (let column = 0; column < 32; column += 1) {
        const x = Math.floor(width * (0.3 + (0.4 * column) / 31)),
          y = Math.floor(height * (0.35 + (0.3 * row) / 23));
        const index = (y * width + x) * 4;
        const [r, g, b] = [data[index]!, data[index + 1]!, data[index + 2]!];
        lumas.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
        blueness += b - r;
      }
    return { digest, lumas, blueness: blueness / lumas.length };
  }, hideWater);
}

function correlation(left: readonly number[], right: readonly number[]): number {
  const mean = (values: readonly number[]) => values.reduce((a, b) => a + b, 0) / values.length;
  const ml = mean(left),
    mr = mean(right);
  let covariance = 0,
    vl = 0,
    vr = 0;
  for (const [index, value] of left.entries()) {
    const a = value - ml,
      b = right[index]! - mr;
    covariance += a * b;
    vl += a * a;
    vr += b * b;
  }
  return covariance / Math.sqrt(vl * vr);
}

for (const projection of ["perspective", "isometric"] as const) {
  test(`water shows the pool bed through it in ${projection} view`, async ({
    page,
    request,
  }, info) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    await open(page, world, POOL);
    if (projection === "isometric") {
      await page.evaluate(() => window.__projectionViewer!.setProjection("isometric", false));
      await settle(page);
    }
    const bed = await still(page, true);
    const water = await still(page);
    await page
      .locator("canvas")
      .screenshot({ path: `test-results/${info.project.name}-${projection}-pool.png` });
    // The checkerboard stays visible through shallow water, tinted towards blue.
    expect(correlation(water.lumas, bed.lumas)).toBeGreaterThan(0.6);
    expect(water.blueness).toBeGreaterThan(bed.blueness + 5);
    await page.evaluate(() => window.__projectionViewer!.dispose());
  });
}

test("a perspective view after an isometric round trip draws the same frame as a direct one", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  const view: CameraView = { ...POOL, distance: 160, pitch: 0.42 };
  await open(page, world, view);
  const direct = await still(page);

  await open(page, world, view);
  await page.evaluate(() => window.__projectionViewer!.setProjection("isometric"));
  await page.waitForTimeout(800);
  await settle(page);
  const isometric = await page.evaluate(() => window.__projectionViewer!.snapshot().projection);
  expect(isometric.blend).toBe(1);
  // The render loop was not stopped yet: switch back and let the transition run.
  await page.evaluate(() => window.__projectionViewer!.setProjection("perspective"));
  await page.waitForTimeout(800);
  await settle(page);
  const back = await page.evaluate(() => window.__projectionViewer!.snapshot());
  expect(back.projection.blend).toBe(0);
  const returned = await still(page);
  expect(returned.digest).toBe(direct.digest);
  await page.evaluate(() => window.__projectionViewer!.dispose());
});

for (const projection of ["perspective", "isometric"] as const) {
  test(`a left-button drag moves the ${projection} view with the pointer`, async ({
    page,
    request,
  }) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    await open(page, world, { ...POOL, distance: 120, pitch: 0.6 });
    if (projection === "isometric")
      await page.evaluate(() => window.__projectionViewer!.setProjection("isometric", false));
    const focus = () =>
      page.evaluate(() => {
        const { x, z } = window.__projectionViewer!.snapshot().view;
        return { x, z };
      });
    const before = await focus();
    const canvas = (await page.locator("canvas").boundingBox())!;
    const x = canvas.x + canvas.width / 2,
      y = canvas.y + canvas.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) await page.mouse.move(x + 20 * step, y);
    await page.mouse.up();
    await page.waitForTimeout(1000);
    const after = await focus();
    // 200 pixels across the 800-pixel canvas: about a quarter of the focus plane width.
    const width = 2 * 120 * Math.tan((25 * Math.PI) / 180) * (800 / 600);
    const moved = Math.hypot(after.x - before.x, after.z - before.z);
    expect(moved).toBeGreaterThan(width * 0.15);
    expect(moved).toBeLessThan(width * 0.4);
    await page.evaluate(() => window.__projectionViewer!.dispose());
  });
}
