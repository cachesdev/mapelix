import { expect, test, type Page } from "@playwright/test";
import type { CameraView, WorldInfo, WorldViewer, WorldViewerOptions } from "@mapelix/viewer/three";

declare global {
  interface Window {
    __textureViewer: WorldViewer | undefined;
  }
}

/** The stone rim of the fixture pool and the checkerboard under its water, close up. */
const VIEW: CameraView = { x: 80, y: 81, z: 16, distance: 40, heading: 0.4, pitch: 0.9 };
const OPTIONS: WorldViewerOptions = { clouds: false, weather: "clear" };

test.beforeEach(async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await page.route("**/texture-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/texture-regression");
});

async function open(
  page: Page,
  world: WorldInfo,
  view: CameraView,
  options: WorldViewerOptions,
): Promise<void> {
  await page.evaluate(
    async ({ world, view, options }) => {
      window.__textureViewer?.dispose();
      const path = "/src/lib/world-viewer.ts",
        { WorldViewer } = await import(path);
      const element = document.getElementById("viewer")!;
      element.replaceChildren();
      const viewer: WorldViewer = await WorldViewer.create(element, world, view, options);
      viewer.setRenderDistance(512);
      window.__textureViewer = viewer;
    },
    { world, view, options },
  );
  await settle(page);
}

async function settle(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const s = window.__textureViewer!.snapshot();
        const loaded = s.streaming.cached > 0 && s.streaming.quads > 0 && !s.streaming.remaining;
        return loaded && !s.streaming.loading && s.textures.state !== "loading";
      }),
    )
    .toBe(true);
  // Region dissolves, texture swaps and the shadow refresh finish.
  await page.waitForTimeout(1000);
}

/**
 * Stops the render loop and draws one frame with the animation clock fixed, so water waves
 * match between views, then returns the SHA-256 of every RGBA pixel.
 */
async function still(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const viewer = window.__textureViewer!;
    const renderer = Reflect.get(viewer, "renderer") as {
      domElement: HTMLCanvasElement;
      setAnimationLoop(loop: null): void;
      _nodes: { nodeFrame: { lastTime: number; time: number } };
    };
    const pipeline = Reflect.get(viewer, "pipeline") as { render(): void };
    renderer.setAnimationLoop(null);
    await new Promise((resolve) => setTimeout(resolve, 50));
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
    }
    const { data } = context.getImageData(0, 0, copy.width, copy.height);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  });
}

const textureState = (page: Page) =>
  page.evaluate(() => {
    const { state, regions } = window.__textureViewer!.snapshot().textures;
    return { state, drawn: regions > 0 };
  });

for (const projection of ["perspective", "isometric"] as const) {
  test(`textures off draw the same pixels as a host without textures (${projection})`, async ({
    page,
    request,
  }) => {
    const world: WorldInfo = await (await request.get("/world.json")).json();
    expect(world.textures?.revision).toMatch(/^[0-9a-f]+$/);
    const { textures: _, ...bare } = world;
    const options = { ...OPTIONS, projection };

    // A host without textures runs the code path that existed before them.
    await open(page, bare, VIEW, options);
    expect(await textureState(page)).toEqual({ state: "off", drawn: false });
    const reference = await still(page);

    // Asking for textures from such a host changes nothing either.
    await open(page, bare, VIEW, { ...options, textures: "on" });
    expect(await textureState(page)).toEqual({ state: "unavailable", drawn: false });
    expect(await still(page)).toBe(reference);

    await open(page, world, VIEW, { ...options, textures: "off", leaves: "detailed" });
    expect(await textureState(page)).toEqual({ state: "off", drawn: false });
    expect(await still(page)).toBe(reference);

    // The view is close enough for textures, so the comparison above means something.
    await open(page, world, VIEW, { ...options, textures: "on" });
    expect(await textureState(page)).toEqual({ state: "on", drawn: true });
    expect(await still(page)).not.toBe(reference);

    // Turning them off again restores every pixel.
    await open(page, world, VIEW, { ...options, textures: "on" });
    await page.evaluate(() => window.__textureViewer!.setLeaves("detailed"));
    await settle(page);
    await page.evaluate(() => window.__textureViewer!.setTextures("off"));
    await settle(page);
    expect(await textureState(page)).toEqual({ state: "off", drawn: false });
    expect(await still(page)).toBe(reference);
    await page.evaluate(() => window.__textureViewer!.dispose());
  });
}
