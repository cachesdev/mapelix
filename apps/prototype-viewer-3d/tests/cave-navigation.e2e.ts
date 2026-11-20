import { expect, test, type Page } from "@playwright/test";
import type { WorldViewer, WorldInfo } from "@mapelix/viewer/three";
import type { CameraRig, Terrain } from "@mapelix/viewer/three/camera-rig";

declare global {
  interface Window {
    __navigationViewer: WorldViewer | undefined;
  }
}

async function unfocus(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
}

test.beforeEach(async ({ page }, testInfo) => {
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
});

test("held keyboard ascent follows depth without changing zoom/angles; manual preference survives reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/world.json")) requests++;
  });
  await page.goto(
    "/?mode=caves&minY=-48&maxY=-16&x=16&y=-21&z=16&distance=60&heading=35&pitch=42&autoDepth=1",
  );
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 30_000 });
  const canvas = await page.locator("canvas").elementHandle();
  await unfocus(page);
  try {
    await page.keyboard.down("PageUp");
    await expect.poll(() => new URL(page.url()).searchParams.get("minY")).toBe("-32");
  } finally {
    await page.keyboard.up("PageUp");
  }
  const url = new URL(page.url());
  expect(url.searchParams.get("maxY")).toBe("0");
  expect(url.searchParams.get("distance")).toBe("60");
  expect(url.searchParams.get("heading")).toBe("35");
  expect(url.searchParams.get("pitch")).toBe("42");
  expect(requests).toBe(2);
  expect(await canvas!.evaluate((node) => node === document.querySelector("canvas"))).toBe(true);
  const automatic = page.getByLabel("Follow depth automatically");
  await automatic.uncheck();
  await unfocus(page);
  await page.keyboard.down("PageUp");
  await page.waitForTimeout(1000);
  await page.keyboard.up("PageUp");
  expect(new URL(page.url()).searchParams.get("minY")).toBe("-32");
  await expect.poll(() => new URL(page.url()).searchParams.get("autoDepth")).toBe("0");
  await page.reload();
  await expect(automatic).not.toBeChecked();
  // Editing coordinates must never move the camera or trigger another depth.
  const coordinate = page.getByLabel("X", { exact: true });
  await coordinate.focus();
  const before = requests;
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(350);
  expect(requests).toBe(before);
  expect(errors).toEqual([]);
});

test("touch holds move vertically, cancellation stops movement, and recovery clears an awkward camera pose", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/?mode=caves&minY=-64&maxY=-32&x=16&y=-48&z=16&distance=8&pitch=12&autoDepth=0");
  const up = page.getByRole("button", { name: "↑ Ascend", exact: true });
  await expect(up).toBeVisible({ timeout: 30_000 });
  const cdp = await page.context().newCDPSession(page);
  const box = (await up.boundingBox())!;
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  });
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("y"))).toBeGreaterThan(-46);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
  await page.waitForTimeout(350);
  const stopped = Number(new URL(page.url()).searchParams.get("y"));
  await page.waitForTimeout(400);
  expect(Number(new URL(page.url()).searchParams.get("y"))).toBe(stopped);
  await page.getByRole("button", { name: "Recover view", exact: true }).click();
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("distance"))).toBe(80);
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("pitch"))).toBe(60);
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("y"))).toBe(-48);
  for (const width of [320, 430]) {
    await page.setViewportSize({ width, height: 900 });
    const box = (await page
      .getByRole("button", { name: "Recover view", exact: true })
      .boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
  await page.screenshot({
    path: `test-results/${testInfo.project.name}-cave-navigation-mobile.png`,
  });
});

test("caves bypass wall trapping and cancel a late automatic slice when returning to Surface", async ({
  page,
  request,
}) => {
  const requested: URL[] = [];
  await page.route("**/navigation-regions/**", (route) => {
    const url = new URL(route.request().url());
    requested.push(new URL(url));
    url.pathname = url.pathname.replace("/navigation-regions/", "/regions/").replace(/\.bin$/, "");
    return route.continue({ url: url.toString() });
  });
  const caves: WorldInfo = await (
    await request.get("/world.json?mode=caves&minY=-48&maxY=-16")
  ).json();
  const surface: WorldInfo = await (await request.get("/world.json")).json();
  await page.route("**/navigation-harness", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  await page.goto("/navigation-harness");
  const result = await page.evaluate(
    async ({ caves, surface }) => {
      const path = "/src/lib/world-viewer.ts";
      const { WorldViewer } = await import(path);
      const pending: {
        signal: AbortSignal;
        resolve: (world: WorldInfo) => void;
        context: Record<string, unknown>;
      }[] = [];
      const changes: { minY: number; maxY: number }[] = [];
      const viewer: WorldViewer = await WorldViewer.create(
        document.getElementById("viewer")!,
        caves,
        { x: 16, y: -21, z: 16, distance: 8, pitch: 0.5, heading: 0.4 },
        {
          autoDepth: true,
          regionBase: "/navigation-regions",
          regionSuffix: ".bin",
          onDepthChange: (context: { minY: number; maxY: number }) => {
            changes.push(context);
          },
          loadDepth: (context: Record<string, unknown>, signal: AbortSignal) =>
            new Promise((resolve) => {
              pending.push({ context, signal, resolve });
            }),
        },
      );
      window.__navigationViewer = viewer;
      const rig = Reflect.get(viewer, "rig") as CameraRig;
      const terrain = Reflect.get(rig, "terrain") as Terrain;
      let raycasts = 0;
      terrain.raycast = () => {
        raycasts++;
        return { distance: 0, axis: 0, sign: 1 };
      };
      viewer.faceNorth();
      for (let i = 0; i < 60; i++) rig.update(1 / 60);
      const caveRaycasts = raycasts;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = performance.now() + 20_000;
      while (viewer.snapshot().streaming.remaining || viewer.snapshot().streaming.loading) {
        if (performance.now() > deadline) throw new Error("Terrain did not settle");
        await wait(30);
      }
      viewer.setVerticalMovement(1);
      while (!pending.length) {
        if (performance.now() > deadline) throw new Error("Depth was not requested");
        await wait(30);
      }
      await wait(500);
      const simultaneous = pending.length;
      pending[0]!.resolve({ ...caves, ...pending[0]!.context } as WorldInfo);
      while (changes.length < 1) {
        if (performance.now() > deadline) throw new Error("The host was not notified");
        await wait(30);
      }
      viewer.focusOn({ x: 16, y: -5, z: 16 });
      while (pending.length < 2) {
        if (performance.now() > deadline) throw new Error("The following depth was not requested");
        await wait(30);
      }
      viewer.setWorld(surface);
      const aborted = pending[1]!.signal.aborted;
      pending[1]!.resolve({ ...caves, ...pending[1]!.context } as WorldInfo);
      await wait(100);
      const mode = viewer.snapshot().context.mode;
      viewer.faceNorth();
      const surfaceRaycasts = raycasts;
      viewer.dispose();
      window.__navigationViewer = undefined;
      return { caveRaycasts, simultaneous, aborted, mode, surfaceRaycasts, changes };
    },
    { caves, surface },
  );
  expect(result.caveRaycasts).toBe(0);
  expect(result.simultaneous).toBe(1);
  expect(result.aborted).toBe(true);
  expect(result.mode).toBe("surface");
  expect(result.surfaceRaycasts).toBeGreaterThan(0);
  expect(result.changes).toHaveLength(1);
  expect(result.changes[0]).toMatchObject({ minY: -32, maxY: 0 });
  expect(requested.length).toBeGreaterThan(0);
  expect(
    requested.every(
      (url) => url.pathname.startsWith("/navigation-regions/") && url.pathname.endsWith(".bin"),
    ),
  ).toBe(true);
  expect(requested.some((url) => url.searchParams.get("minY") === "-32")).toBe(true);
  await expect(page.locator("canvas")).toHaveCount(0);
});
