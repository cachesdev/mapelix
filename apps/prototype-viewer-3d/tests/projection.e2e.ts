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

/** North of the fixture house, looking north over its roof from the south. */
const BEHIND_HOUSE: CameraView = { x: 41, y: 81, z: 2, distance: 40, heading: 0, pitch: 0.6 };

for (const input of ["key", "drag"] as const) {
  test(`an isometric view keeps its scale when a ${input} starts over a roof`, async ({
    page,
    request,
  }) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    await open(page, world, BEHIND_HOUSE);
    await page.evaluate(() => window.__projectionViewer!.setProjection("isometric", false));
    await settle(page);
    const scale = () =>
      page.evaluate(() => window.__projectionViewer!.snapshot().projection.pixelsPerBlock);
    const before = await scale();
    // The line from the camera to the focus crosses the roof, where the pivot moves to.
    if (input === "key") {
      await page.locator("canvas").focus();
      await page.keyboard.down("KeyD");
      await page.waitForTimeout(150);
      await page.keyboard.up("KeyD");
    } else {
      const canvas = (await page.locator("canvas").boundingBox())!;
      const x = canvas.x + canvas.width / 2,
        y = canvas.y + canvas.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 4; step += 1) await page.mouse.move(x + 5 * step, y);
      await page.mouse.up();
    }
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => window.__projectionViewer!.snapshot());
    expect(after.projection.blend).toBe(1);
    expect(after.projection.pixelsPerBlock / before).toBeCloseTo(1, 2);
    // The pivot now rests on the roof, five blocks above the ground.
    expect(after.view.y).toBeGreaterThan(84);
    await page.evaluate(() => window.__projectionViewer!.dispose());
  });
}

test("switching an isometric view back to perspective brings the camera out of a building", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  // An isometric camera may stand inside the house; the view shows the house from outside.
  const inside: CameraView = { x: 41, y: 81, z: -6, distance: 16, heading: 0, pitch: 0.12 };
  await open(page, world, BEHIND_HOUSE);
  await page.evaluate((view) => {
    const viewer = window.__projectionViewer!;
    viewer.setProjection("isometric", false);
    viewer.setCameraView(view);
  }, inside);
  await settle(page);
  await page.evaluate(() => window.__projectionViewer!.setProjection("perspective"));
  await page.waitForTimeout(800);
  const { view, projection } = await page.evaluate(() => window.__projectionViewer!.snapshot());
  expect(projection.blend).toBe(0);
  const cameraZ = view.z + Math.cos(view.heading) * Math.cos(view.pitch) * view.distance;
  // The north wall of the house stands at z 4.
  expect(cameraZ).toBeLessThan(4);
  expect(view.distance).toBeGreaterThanOrEqual(6);
  await page.evaluate(() => window.__projectionViewer!.dispose());
});

/** Over the flat stone west of the house, ground top at y 81. */
const FIELD: CameraView = { x: 34, y: 81, z: 1, distance: 20, heading: 0, pitch: 1.2 };

/** Holds a key on the canvas for `ms` milliseconds. */
async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.locator("canvas").focus();
  await page.keyboard.down(key);
  // Repeats keep the key alive past the 600 ms lease, as a held key does.
  for (let elapsed = 0; elapsed < ms; elapsed += 100) {
    await page.waitForTimeout(Math.min(100, ms - elapsed));
    await page.keyboard.down(key);
  }
  await page.keyboard.up(key);
}

function cameraY(view: CameraView): number {
  return view.y + Math.sin(view.pitch) * view.distance;
}

for (const projection of ["perspective", "isometric"] as const) {
  test(`Space and C move a ${projection} Surface view up and down, never below the terrain`, async ({
    page,
    request,
  }) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    await open(page, world, FIELD);
    if (projection === "isometric")
      await page.evaluate(() => window.__projectionViewer!.setProjection("isometric", false));
    const snapshot = () => page.evaluate(() => window.__projectionViewer!.snapshot());
    const start = await snapshot();

    await hold(page, "Space", 400);
    const raised = await snapshot();
    expect(cameraY(raised.view) - cameraY(start.view)).toBeGreaterThan(5);
    expect(raised.projection.pixelsPerBlock / start.projection.pixelsPerBlock).toBeCloseTo(1, 3);
    // The focus stays up: nothing eases it back onto the ground.
    await page.waitForTimeout(1000);
    expect((await snapshot()).view.y).toBeCloseTo(raised.view.y, 3);

    await hold(page, "KeyC", 3000);
    const lowered = await snapshot();
    expect(cameraY(lowered.view)).toBeLessThan(cameraY(start.view) - 10);
    // The camera stops above the stone: on its face in perspective, 2.5 blocks over it in
    // the isometric view, which only follows the height map.
    expect(cameraY(lowered.view)).toBeGreaterThan(81);
    expect(lowered.projection.pixelsPerBlock / start.projection.pixelsPerBlock).toBeCloseTo(1, 3);
    await page.evaluate(() => window.__projectionViewer!.dispose());
  });
}

test("vertical moves follow the zoom, at the same pace in both projections", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  const rise = async (projection: "perspective" | "isometric", distance: number) => {
    await open(page, world, { ...FIELD, distance });
    await page.evaluate(
      (projection) => window.__projectionViewer!.setProjection(projection, false),
      projection,
    );
    const before = await page.evaluate(() => window.__projectionViewer!.snapshot().view.y);
    const started = Date.now();
    await hold(page, "Space", 500);
    const after = await page.evaluate(() => window.__projectionViewer!.snapshot().view.y);
    return (after - before) / ((Date.now() - started) / 1000);
  };
  const close = await rise("perspective", 20);
  const far = await rise("perspective", 140);
  const farIsometric = await rise("isometric", 140);
  // 24 blocks per second up close, 154 at 140 blocks (the keyboard pace of WASD).
  expect(close).toBeGreaterThan(12);
  expect(close).toBeLessThan(30);
  expect(far).toBeGreaterThan(close * 3);
  expect(farIsometric / far).toBeGreaterThan(0.7);
  expect(farIsometric / far).toBeLessThan(1.4);
  await page.evaluate(() => window.__projectionViewer!.dispose());
});

for (const pitch of [1.53, 0.7]) {
  test(`switching projections over flat ground keeps the camera off it (pitch ${pitch})`, async ({
    page,
    request,
  }) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    await open(page, world, { ...FIELD, distance: 107, pitch });
    const distance = () => page.evaluate(() => window.__projectionViewer!.snapshot().view.distance);
    for (const projection of ["isometric", "perspective", "isometric", "perspective"] as const) {
      await page.evaluate((p) => window.__projectionViewer!.setProjection(p), projection);
      await page.waitForTimeout(900);
      expect(await distance()).toBeCloseTo(107, 0);
    }
    await page.evaluate(() => window.__projectionViewer!.dispose());
  });
}

test("an isometric camera below the terrain still turns about what shows in the middle", async ({
  page,
  request,
}) => {
  const world: WorldInfo = await (await request.get("/world.json")).json();
  await open(page, world, BEHIND_HOUSE);
  // A focus deep under the stone puts the camera under the ground too; the view shows the roof.
  await page.evaluate(() => {
    const viewer = window.__projectionViewer!;
    viewer.setProjection("isometric", false);
    viewer.setCameraView({ y: 40, z: 2 - 41 / Math.tan(0.6) });
  });
  await settle(page);
  await page.locator("canvas").focus();
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(100);
  await page.keyboard.up("KeyD");
  await page.waitForTimeout(300);
  const { view } = await page.evaluate(() => window.__projectionViewer!.snapshot());
  // The pivot rests on the roof or the stone in view, not under the ground.
  expect(view.y).toBeGreaterThan(80);
  await page.evaluate(() => window.__projectionViewer!.dispose());
});
