import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { MapelixViewer, MarkerInput } from "@mapelix/viewer";
import { WORLD_URL } from "../playwright.config";

declare global {
  interface Window {
    __mapelixViewer: MapelixViewer | undefined;
    __mapelixMarkerStore: { failNext: string | undefined } | undefined;
  }
}

const CAPTURES = process.env.MAPELIX_CAPTURES;
/** Over the fixture's stone platform, below the switch scale (4 px per block). */
const START = `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=4`;
const STORE = "mapelix-demo-markers-v1";

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

async function tap(page: Page, point: Point, phone: boolean): Promise<void> {
  if (phone) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function longPress(page: Page, point: Point, phone: boolean, ms = 700): Promise<void> {
  if (phone) await touch(page, "touchStart", [point]);
  else {
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
  }
  await page.waitForTimeout(ms);
  if (phone) await touch(page, "touchEnd", []);
  else await page.mouse.up();
}

async function drag(page: Page, from: Point, to: Point, phone: boolean, steps = 10): Promise<void> {
  const at = (i: number) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  });
  if (phone) await touch(page, "touchStart", [from]);
  else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
  }
  for (let i = 1; i <= steps; i += 1) {
    if (phone) await touch(page, "touchMove", [at(i)]);
    else await page.mouse.move(at(i).x, at(i).y);
    await page.waitForTimeout(16);
  }
  if (phone) await touch(page, "touchEnd", []);
  else await page.mouse.up();
}

async function open(page: Page, url = START): Promise<void> {
  await page.goto(url);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer?.map.snapshot().pending === 0))
    .toBe(true);
  // The demo's stored markers arrive first; the tests then show their own.
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.markers.list().length))
    .toBeGreaterThan(0);
}

async function setMarkers(page: Page, markers: MarkerInput[]): Promise<void> {
  await page.evaluate((list) => window.__mapelixViewer!.markers.set(list), markers);
  await page.waitForTimeout(100);
}

async function iconOf(page: Page, name: string): Promise<Point> {
  const point = await page.evaluate((label) => {
    for (const element of document.querySelectorAll(".mx-marker"))
      if (element.getAttribute("aria-label") === label) {
        const box = element.querySelector(".mx-marker-icon")!.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
    return undefined;
  }, name);
  expect(point, name).toBeDefined();
  return point!;
}

function center(page: Page): Point {
  const size = page.viewportSize()!;
  return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
}

async function stored(page: Page): Promise<MarkerInput[]> {
  return page.evaluate(
    (key) =>
      (JSON.parse(localStorage.getItem(key) ?? '{"markers":[]}') as { markers: MarkerInput[] })
        .markers,
    STORE,
  );
}

const sheet = (page: Page) => page.locator(".mx-panel");
const card = (page: Page) => page.locator(".mx-card");
const field = (page: Page, name: string) => sheet(page).locator(`[name="${name}"]`);

/** Controls, coordinates, panel and card: none over another, all on screen. */
async function checkNoOverlap(page: Page, label: string): Promise<void> {
  await page.waitForTimeout(250);
  if (CAPTURES) {
    await mkdir(resolve(CAPTURES), { recursive: true });
    await page.screenshot({ path: resolve(CAPTURES, `editor-${label}.png`) });
  }
  const result = await page.evaluate(() => {
    const boxes: { name: string; l: number; r: number; t: number; b: number }[] = [];
    const ui = document.querySelector(".mx-ui")!;
    const add = (element: Element, name: string) => {
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      boxes.push({ name, l: box.left, r: box.right, t: box.top, b: box.bottom });
    };
    for (const button of ui.querySelectorAll(".mx-btn"))
      if (!button.closest(".mx-panel, .mx-card"))
        add(button, button.getAttribute("aria-label") ?? "button");
    for (const [selector, name] of [
      [".mx-readout", "coordinates"],
      [".mx-panel", "panel"],
      [".mx-card", "card"],
    ] as const)
      for (const element of ui.querySelectorAll(selector)) add(element, name);
    return { boxes, width: innerWidth, height: innerHeight };
  });
  for (const box of result.boxes) {
    expect(box.l, `${label}: ${box.name}`).toBeGreaterThanOrEqual(0);
    expect(box.t, `${label}: ${box.name}`).toBeGreaterThanOrEqual(0);
    expect(box.r, `${label}: ${box.name}`).toBeLessThanOrEqual(result.width + 0.5);
    expect(box.b, `${label}: ${box.name}`).toBeLessThanOrEqual(result.height + 0.5);
  }
  for (const [i, a] of result.boxes.entries())
    for (const b of result.boxes.slice(i + 1))
      expect(
        a.r <= b.l + 0.5 || b.r <= a.l + 0.5 || a.b <= b.t + 0.5 || b.b <= a.t + 0.5,
        `${label}: ${a.name} overlaps ${b.name}`,
      ).toBe(true);
}

test("add with the button and a tap, edit, then delete after confirming", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await open(page);
  await setMarkers(page, []);
  const add = page.locator("[data-part=add-marker]");
  await expect(add).toHaveAttribute("aria-label", "Add a marker");
  await add.click();
  await expect(add).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".mx-note")).toContainText("Tap the map where the marker goes");
  await checkNoOverlap(page, `${info.project.name}-placing`);

  // A tap places the new marker on the block under it.
  const point = { x: center(page).x + 40, y: center(page).y - 60 };
  await tap(page, point, phone);
  await expect(sheet(page)).toBeVisible();
  await expect(sheet(page).locator("h2")).toHaveText("New marker");
  await expect(add).toHaveAttribute("aria-pressed", "false");
  const view = await page.evaluate(() => window.__mapelixViewer!.view);
  const block = {
    x: Math.floor(view.x + (point.x - center(page).x) / view.pixelsPerBlock),
    z: Math.floor(view.z + (point.y - center(page).y) / view.pixelsPerBlock),
  };
  expect(Math.abs(Number(await field(page, "x").inputValue()) - block.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(Number(await field(page, "z").inputValue()) - block.z)).toBeLessThanOrEqual(1);
  // The host's extra field, drawn generically.
  await expect(field(page, "field-public")).toBeChecked();
  await checkNoOverlap(page, `${info.project.name}-new`);

  // The host refuses a draft without a name; its message shows.
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(sheet(page).getByRole("alert")).toHaveText("Give the place a name.");
  await field(page, "label").fill("Camp");
  await sheet(page).getByRole("button", { name: "Icon ▲" }).click();
  await expect(field(page, "icon")).toHaveValue("▲");
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(sheet(page)).toBeHidden();
  await expect(card(page).locator("h2")).toHaveText("Camp");
  await expect(card(page)).toContainText("Public");
  const saved = (await stored(page)).find((marker) => marker.label === "Camp")!;
  expect(saved).toBeDefined();
  expect(saved.icon).toBe("▲");
  expect(
    await page.evaluate((id) => window.__mapelixViewer!.markers.get(id)?.label, saved.id),
  ).toBe("Camp");
  await checkNoOverlap(page, `${info.project.name}-card`);

  // Edit: new name, Z moved by 5, private.
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(sheet(page).locator("h2")).toHaveText("Edit marker");
  await expect(field(page, "label")).toHaveValue("Camp");
  await field(page, "label").fill("Camp 2");
  await field(page, "z").fill(String(saved.z + 5));
  await field(page, "field-public").uncheck();
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(card(page).locator("h2")).toHaveText("Camp 2");
  await expect(card(page)).toContainText("Private");
  const edited = (await stored(page)).find((marker) => marker.id === saved.id)!;
  expect(edited).toMatchObject({ label: "Camp 2", z: saved.z + 5, data: { public: false } });
  expect(await page.evaluate((id) => window.__mapelixViewer!.markers.get(id)?.z, saved.id)).toBe(
    saved.z + 5,
  );

  // Delete asks first; Cancel keeps the marker.
  await card(page).getByRole("button", { name: "Delete" }).click();
  await expect(card(page)).toContainText("Delete “Camp 2”? This cannot be undone.");
  await card(page).getByRole("button", { name: "Cancel" }).click();
  expect(
    await page.evaluate((id) => window.__mapelixViewer!.markers.get(id) !== undefined, saved.id),
  ).toBe(true);
  await card(page).getByRole("button", { name: "Delete" }).click();
  await checkNoOverlap(page, `${info.project.name}-confirm`);
  await card(page).locator("[data-part=confirm-delete]").click();
  await expect(card(page)).toBeHidden();
  expect(
    await page.evaluate((id) => window.__mapelixViewer!.markers.get(id), saved.id),
  ).toBeUndefined();
  expect((await stored(page)).some((marker) => marker.id === saved.id)).toBe(false);
});

test("a long press adds a marker in 2D and in 3D; pan and pinch still work", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const phone = info.project.name === "phone";
  await open(page);
  await setMarkers(page, []);
  const spot = { x: center(page).x - 30, y: center(page).y + 40 };

  // A drag moves the map and opens nothing, even when it lasts.
  const before = await page.evaluate(() => window.__mapelixViewer!.view);
  await drag(page, spot, { x: spot.x - 100, y: spot.y - 50 }, phone, 40);
  await page.waitForTimeout(700);
  await expect(sheet(page)).toBeHidden();
  const after = await page.evaluate(() => window.__mapelixViewer!.view);
  expect(Math.abs(after.x - before.x)).toBeGreaterThan(10);

  if (phone) {
    // Two fingers held still, then spread: a pinch, never a new marker.
    const scale = after.pixelsPerBlock;
    const c = center(page);
    await touch(page, "touchStart", [
      { x: c.x - 40, y: c.y },
      { x: c.x + 40, y: c.y },
    ]);
    await page.waitForTimeout(700);
    for (let i = 1; i <= 10; i += 1) {
      await touch(page, "touchMove", [
        { x: c.x - 40 - i * 6, y: c.y },
        { x: c.x + 40 + i * 6, y: c.y },
      ]);
      await page.waitForTimeout(16);
    }
    await touch(page, "touchEnd", []);
    await page.waitForTimeout(400);
    await expect(sheet(page)).toBeHidden();
    expect(await page.evaluate(() => window.__mapelixViewer!.view.pixelsPerBlock)).toBeGreaterThan(
      scale,
    );
    await open(page);
    await setMarkers(page, []);
  }

  // 2D: the form opens on the block under the finger; Cancel adds nothing.
  const flat = await page.evaluate(({ x, y }) => window.__mapelixViewer!.pickBlock(x, y), spot);
  await longPress(page, spot, phone);
  await expect(sheet(page).locator("h2")).toHaveText("New marker");
  expect(Number(await field(page, "x").inputValue())).toBe(flat!.x);
  expect(Number(await field(page, "z").inputValue())).toBe(flat!.z);
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.list().length)).toBe(1);
  await sheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(sheet(page)).toBeHidden();
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.list().length)).toBe(0);

  // 3D: the block the 3D view picks under the finger.
  await page.evaluate(() => window.__mapelixViewer!.goTo(40, 8));
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.mode), { timeout: 20_000 })
    .toBe("3d");
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.status.loading), { timeout: 30_000 })
    .toBe(0);
  await page.waitForTimeout(400);
  // The first point, above the form's place, where the 3D view hits a block.
  const hit = await page.evaluate(() => {
    const viewer = window.__mapelixViewer!;
    for (let y = 150; y <= innerHeight / 2; y += 20)
      for (let x = 60; x <= innerWidth - 60; x += 20) {
        const block = viewer.pickBlock(x, y);
        if (block !== undefined) return { point: { x, y }, block };
      }
    return undefined;
  });
  expect(hit).toBeDefined();
  await longPress(page, hit!.point, phone);
  await expect(sheet(page).locator("h2")).toHaveText("New marker");
  expect(Number(await field(page, "x").inputValue())).toBe(hit!.block.x);
  expect(Number(await field(page, "z").inputValue())).toBe(hit!.block.z);
  await field(page, "label").fill("Tower");
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(card(page).locator("h2")).toHaveText("Tower");
  expect((await stored(page)).some((marker) => marker.label === "Tower")).toBe(true);
  await checkNoOverlap(page, `${info.project.name}-3d-card`);
});

test("the marker being edited follows a drag; the current position fills X and Z", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await open(page);
  await setMarkers(page, [{ id: "a", x: 46, z: 14, label: "Alpha", icon: "A" }]);
  await tap(page, await iconOf(page, "Alpha"), phone);
  await expect(card(page).locator("h2")).toHaveText("Alpha");
  await card(page).getByRole("button", { name: "Edit" }).click();
  await expect(sheet(page)).toBeVisible();
  // On a phone the map brings the marker out from under the form.
  await page.waitForTimeout(400);

  // 40 px at 4 px per block: 10 blocks east; the view stays.
  const view = await page.evaluate(() => window.__mapelixViewer!.view);
  const from = await iconOf(page, "Alpha");
  await drag(page, from, { x: from.x + 40, y: from.y }, phone);
  await page.waitForTimeout(200);
  expect(Number(await field(page, "x").inputValue())).toBe(56);
  expect(Number(await field(page, "z").inputValue())).toBe(14);
  const moved = await page.evaluate(() => window.__mapelixViewer!.markers.get("a"));
  expect(moved).toMatchObject({ x: 56, z: 14 });
  const still = await page.evaluate(() => window.__mapelixViewer!.view);
  expect(still.x).toBeCloseTo(view.x, 5);
  expect(still.z).toBeCloseTo(view.z, 5);
  await expect(sheet(page)).toBeVisible();

  await sheet(page).getByRole("button", { name: "Use the current position" }).click();
  expect(Number(await field(page, "x").inputValue())).toBe(Math.floor(view.x));
  expect(Number(await field(page, "z").inputValue())).toBe(Math.floor(view.z));
  await field(page, "x").fill("abc");
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(sheet(page).getByRole("alert")).toContainText("whole numbers");

  // Cancel puts the marker back where it was.
  await sheet(page).getByRole("button", { name: "Cancel" }).click();
  await expect(sheet(page)).toBeHidden();
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.get("a"))).toMatchObject({
    x: 46,
    z: 14,
  });
});

test("the host refuses a save or a delete: its message shows and nothing changes", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await open(page);
  await setMarkers(page, [
    { id: "a", x: 46, z: 14, label: "Alpha", icon: "A" },
    { id: "spawn", x: 20, z: -20, label: "Spawn", icon: "★" },
  ]);
  await tap(page, await iconOf(page, "Alpha"), phone);
  await card(page).getByRole("button", { name: "Edit" }).click();
  await field(page, "label").fill("Alpha 2");
  await page.evaluate(() => (window.__mapelixMarkerStore!.failNext = "The server is offline."));
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(sheet(page).getByRole("alert")).toHaveText("The server is offline.");
  await expect(sheet(page).getByRole("button", { name: "Save" })).toBeEnabled();
  expect((await stored(page)).some((marker) => marker.label === "Alpha 2")).toBe(false);
  await checkNoOverlap(page, `${info.project.name}-refused`);
  // A second try goes through.
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(card(page).locator("h2")).toHaveText("Alpha 2");

  await page.evaluate(() => (window.__mapelixMarkerStore!.failNext = "Not allowed."));
  await card(page).getByRole("button", { name: "Delete" }).click();
  await card(page).locator("[data-part=confirm-delete]").click();
  await expect(card(page).getByRole("alert")).toHaveText("Not allowed.");
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.get("a")?.label)).toBe(
    "Alpha 2",
  );

  // The host's rights: the spawn is shown, not editable.
  await card(page).getByRole("button", { name: "Close" }).click();
  await tap(page, await iconOf(page, "Spawn"), phone);
  await expect(card(page).locator("h2")).toHaveText("Spawn");
  await expect(card(page)).toContainText("This marker cannot be changed here.");
  await expect(card(page).getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Delete" })).toHaveCount(0);
});

test("a read-only map shows marker cards and nothing to edit", async ({ page }, info) => {
  const phone = info.project.name === "phone";
  await open(page, `${START}&readonly=1`);
  await setMarkers(page, [{ id: "a", x: 46, z: 14, label: "Alpha", icon: "A" }]);
  await expect(page.locator("[data-part=add-marker]")).toHaveCount(0);
  await tap(page, await iconOf(page, "Alpha"), phone);
  await expect(card(page).locator("h2")).toHaveText("Alpha");
  await expect(card(page).getByRole("button", { name: "Edit" })).toHaveCount(0);
  await expect(card(page).getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(card(page)).not.toContainText("cannot be changed");
  // A tap beside the marker closes the card; a long press opens nothing.
  await tap(page, { x: center(page).x - 60, y: center(page).y + 80 }, phone);
  await expect(card(page)).toBeHidden();
  await longPress(page, { x: center(page).x - 60, y: center(page).y + 80 }, phone);
  await expect(sheet(page)).toBeHidden();
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.list().length)).toBe(1);
});

test("with the phone keyboard up, the field and Save stay in view", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone keyboard");
  await open(page);
  await setMarkers(page, []);
  await longPress(page, center(page), true);
  await expect(sheet(page)).toBeVisible();
  await field(page, "label").focus();
  // An Android keyboard resizes the page (interactive-widget=resizes-content).
  await page.setViewportSize({ width: 375, height: 430 });
  await page.waitForTimeout(500);
  await expect(page.locator(".mx-ui")).toHaveAttribute("data-typing", "");
  for (const target of [field(page, "label"), sheet(page).getByRole("button", { name: "Save" })]) {
    const box = (await target.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(430 + 0.5);
  }
  await checkNoOverlap(page, "phone-keyboard");
  await field(page, "label").fill("Typed");
  await sheet(page).getByRole("button", { name: "Save" }).click();
  await expect(card(page).locator("h2")).toHaveText("Typed");
});
