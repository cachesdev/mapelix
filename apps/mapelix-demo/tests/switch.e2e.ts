import { expect, test, type CDPSession, type Page } from "@playwright/test";
import type { MapelixViewer, ViewState } from "@mapelix/viewer";
import { WORLD_URL } from "../playwright.config";

declare global {
  interface Window {
    __mapelixViewer: MapelixViewer | undefined;
  }
}

/** Over the fixture's stone platform, just below the switch scale. */
const START = "/?dimension=overworld&x=40&z=8&scale=4";
const TOP_DOWN = Math.PI / 2 - 0.04;

type Point = { x: number; y: number };
const sessions = new WeakMap<Page, CDPSession>();

async function touch(
  page: Page,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: Point[],
): Promise<void> {
  let session = sessions.get(page);
  if (session === undefined)
    sessions.set(page, (session = await page.context().newCDPSession(page)));
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, id) => ({ ...point, id })),
  });
}

/** Two fingers moving from `from` to `to` pixels apart, around `center`. */
async function pinch(page: Page, center: Point, from: number, to: number): Promise<void> {
  const fingers = (gap: number): Point[] => [
    { x: center.x - gap / 2, y: center.y },
    { x: center.x + gap / 2, y: center.y },
  ];
  await touch(page, "touchStart", fingers(from));
  for (let i = 1; i <= 12; i += 1) {
    await touch(page, "touchMove", fingers(from + ((to - from) * i) / 12));
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(80);
  await touch(page, "touchEnd", []);
}

const state = (page: Page) => page.evaluate(() => window.__mapelixViewer!.view);
const mapView = (page: Page) => page.evaluate(() => window.__mapelixViewer!.map.view);

async function open(page: Page, url: string): Promise<Point> {
  await page.goto(url);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer?.map.snapshot().pending === 0))
    .toBe(true);
  const size = page.viewportSize()!;
  return { x: size.width / 2, y: size.height / 2 };
}

async function waitForMode(page: Page, mode: ViewState["mode"]): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.mode), { timeout: 20_000 })
    .toBe(mode);
}

test("zooming in turns the map into the 3D world at the same center and scale, and back", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const phone = info.project.name === "phone";
  const center = await open(page, WORLD_URL + START);
  expect(await page.getByRole("button", { name: "Show in 3D" }).count()).toBe(1);

  // In: a double tap on a phone, one wheel notch on a desktop.
  if (phone) {
    await page.touchscreen.tap(center.x, center.y);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(center.x, center.y);
  } else {
    await page.mouse.move(center.x, center.y);
    await page.mouse.wheel(0, -100);
  }
  await waitForMode(page, "3d");
  const map = await mapView(page);
  const world = await state(page);
  expect(map.pixelsPerBlock).toBeGreaterThan(5);
  expect(Math.abs(world.x - map.x)).toBeLessThan(0.5);
  expect(Math.abs(world.z - map.z)).toBeLessThan(0.5);
  expect(world.pixelsPerBlock / map.pixelsPerBlock).toBeCloseTo(1, 2);
  expect(world.heading).toBeCloseTo(0, 6);
  expect(world.pitch).toBeCloseTo(TOP_DOWN, 6);
  expect(world.projection).toBe("isometric");
  await expect(page.getByRole("button", { name: "Show the map" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Isometric view" })).toBeVisible();
  expect(
    await page.evaluate(() => {
      // The map canvas and the 3D canvas.
      return (
        window.__mapelixViewer!.world !== undefined &&
        document.querySelectorAll("canvas").length === 2
      );
    }),
  ).toBe(true);

  // The projection button stays and switches the 3D camera.
  await page.getByRole("button", { name: "Isometric view" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.world!.snapshot().projection.chosen))
    .toBe("perspective");
  await page.getByRole("button", { name: "Isometric view" }).click();

  // Out: a pinch on a phone, the wheel on a desktop.
  // Records the 3D view as it zooms out, to compare the map with its last 3D frame.
  await page.evaluate(() => {
    const trace: ViewState[] = [];
    Reflect.set(window, "__trace", trace);
    setInterval(() => {
      const view = window.__mapelixViewer!.view;
      if (view.mode === "3d") trace.push(view);
    }, 20);
  });
  if (phone) await pinch(page, center, 240, 60);
  else {
    await page.mouse.move(center.x, center.y);
    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(40);
    }
  }
  await waitForMode(page, "2d");
  const back = await mapView(page);
  expect(back.pixelsPerBlock).toBeLessThan(4);
  // The map picks up exactly where the world was.
  const last = await page.evaluate(() => (Reflect.get(window, "__trace") as ViewState[]).at(-1)!);
  expect(Math.hypot(back.x - last.x, back.z - last.z)).toBeLessThan(0.5);
  expect(back.pixelsPerBlock / last.pixelsPerBlock).toBeCloseTo(1, 2);
  const final = await state(page);
  expect(final).toMatchObject({ mode: "2d", heading: 0 });
  await expect(page.getByRole("button", { name: "Show in 3D" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Isometric view" })).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__mapelixViewer!.world === undefined &&
          document.querySelectorAll("canvas").length === 1,
      ),
    )
    .toBe(true);
});

test("a turned and tilted world turns back north and down before the map shows", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Same code path on both");
  test.setTimeout(90_000);
  await open(page, WORLD_URL + START);
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await waitForMode(page, "3d");
  expect((await state(page)).pixelsPerBlock).toBeCloseTo(5, 1);
  await page.evaluate(() => window.__mapelixViewer!.world!.setCameraView({ heading: 2, pitch: 1 }));
  const before = await state(page);
  await page.getByRole("button", { name: "Show the map" }).click();
  await waitForMode(page, "2d");
  const back = await mapView(page);
  expect(Math.hypot(back.x - before.x, back.z - before.z)).toBeLessThan(0.5);
  expect(back.pixelsPerBlock).toBeCloseTo(before.pixelsPerBlock, 1);
});

test("without a world the demo stays a 2D map", async ({ page }) => {
  const center = await open(page, START);
  expect(await page.getByRole("button", { name: "Show in 3D" }).count()).toBe(0);
  await page.evaluate(() => window.__mapelixViewer!.zoomBy(4));
  await expect.poll(async () => (await mapView(page)).pixelsPerBlock).toBeCloseTo(16, 1);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__mapelixViewer!.mode)).toBe("2d");
  expect(center.x).toBeGreaterThan(0);
});

test("after a tap on a button, Space and the movement keys go to the 3D view", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await open(page, WORLD_URL + START);
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await waitForMode(page, "3d");
  const cube = page.getByRole("button", { name: "Isometric view" });
  if (info.project.name === "phone") await cube.tap();
  else await cube.click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.projection))
    .toBe("perspective");
  // The button let go of the focus: Space no longer presses it.
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("CANVAS");
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__mapelixViewer!.projection)).toBe("perspective");
  // The view takes the movement keys.
  const before = await state(page);
  await page.keyboard.down("KeyW");
  await page.waitForTimeout(400);
  await page.keyboard.up("KeyW");
  await expect.poll(async () => (await state(page)).z).toBeLessThan(before.z - 1);
  expect((await state(page)).projection).toBe("perspective");
  // A keyboard press keeps the focus on the button, for Tab users.
  await cube.focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe(
    "Isometric view",
  );
});

test("in caves, after a tap on the cube, Space raises the camera and keeps the projection", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await open(page, WORLD_URL + START);
  await page.evaluate(() => window.__mapelixViewer!.setViewMode("caves"));
  await waitForMode(page, "3d");
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.status.context?.mode))
    .toBe("caves");
  await expect.poll(() => page.evaluate(() => window.__mapelixViewer!.status.changing)).toBe(false);
  const cube = page.getByRole("button", { name: "Isometric view" });
  if (info.project.name === "phone") await cube.tap();
  else await cube.click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.projection))
    .toBe("perspective");
  const y = () => page.evaluate(() => window.__mapelixViewer!.world!.snapshot().view.y);
  const before = await y();
  await page.keyboard.down("Space");
  await page.waitForTimeout(500);
  await page.keyboard.up("Space");
  await expect.poll(y).toBeGreaterThan(before + 1);
  expect(await page.evaluate(() => window.__mapelixViewer!.projection)).toBe("perspective");
});
