import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { MapelixViewer } from "@mapelix/viewer";
import { WORLD_URL } from "../playwright.config";

declare global {
  interface Window {
    __mapelixViewer: MapelixViewer | undefined;
  }
}

/** Set to a folder to keep a screenshot of every checked layout. */
const CAPTURES = process.env.MAPELIX_CAPTURES;

type Box = { name: string; l: number; r: number; t: number; b: number; w: number; h: number };

/** Every visible control, the coordinates, the open panel and the card, as boxes. */
async function layout(page: Page) {
  return page.evaluate(() => {
    const boxes: Box[] = [];
    const add = (element: Element, name: string) => {
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return;
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      boxes.push({
        name,
        l: box.left,
        r: box.right,
        t: box.top,
        b: box.bottom,
        w: box.width,
        h: box.height,
      });
    };
    const ui = document.querySelector(".mx-ui")!;
    for (const button of ui.querySelectorAll(".mx-btn"))
      if (!button.closest(".mx-panel, .mx-card"))
        add(button, button.getAttribute("aria-label") ?? "button");
    for (const [selector, name] of [
      [".mx-readout", "coordinates"],
      [".mx-panel", "panel"],
      [".mx-card", "card"],
    ] as const)
      for (const element of ui.querySelectorAll(selector)) add(element, name);
    const style = getComputedStyle(ui);
    return {
      boxes,
      width: innerWidth,
      height: innerHeight,
      padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft].map(
        parseFloat,
      ),
      scroll: document.scrollingElement!.scrollHeight - innerHeight,
    };
  });
}

/** No overlap between controls, everything on screen, touch targets ≥ 44 px. */
async function checkLayout(page: Page, label: string, panelOpen: boolean): Promise<void> {
  await page.waitForTimeout(250);
  const result = await layout(page);
  if (CAPTURES) {
    await mkdir(resolve(CAPTURES), { recursive: true });
    await page.screenshot({ path: resolve(CAPTURES, `${label}.png`) });
  }
  expect(result.scroll, label).toBeLessThanOrEqual(0);
  for (const box of result.boxes) {
    if (box.name !== "coordinates" && box.name !== "panel" && box.name !== "card")
      expect(Math.min(box.w, box.h), `${label}: ${box.name} size`).toBeGreaterThanOrEqual(44);
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
  // With the panels closed, the center of the map stays clear.
  if (!panelOpen) {
    const x = result.width / 2,
      y = result.height / 2;
    for (const box of result.boxes)
      expect(
        box.l < x && x < box.r && box.t < y && y < box.b,
        `${label}: ${box.name} on center`,
      ).toBe(false);
  }
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer?.map.snapshot().pending === 0))
    .toBe(true);
}

async function to3d(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.mode), { timeout: 20_000 })
    .toBe("3d");
}

const SIZES = {
  phone: [
    ["phone-portrait", 375, 812],
    ["phone-landscape", 812, 375],
  ],
  desktop: [
    ["tablet", 768, 1024],
    ["desktop", 1280, 800],
  ],
} as const;

for (const scheme of ["dark", "light"] as const)
  test(`controls never overlap, in 2D and 3D, panels open or closed (${scheme})`, async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, width, height] of SIZES[info.project.name as "phone" | "desktop"]) {
      const label = `${name}-${scheme}`;
      await page.setViewportSize({ width, height });
      await open(page, `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=2`);
      await checkLayout(page, `${label}-2d`, false);
      await page.getByRole("button", { name: "Settings" }).click();
      await expect(page.locator(".mx-panel")).toBeVisible();
      await checkLayout(page, `${label}-2d-settings`, true);
      await page.keyboard.press("Escape");
      await expect(page.locator(".mx-panel")).toBeHidden();
      await page.getByRole("button", { name: "Dimensions" }).click();
      await checkLayout(page, `${label}-2d-dimensions`, true);
      await page.getByRole("button", { name: "Dimensions" }).click();

      await to3d(page);
      await checkLayout(page, `${label}-3d`, false);
      await page.getByRole("button", { name: "Settings" }).click();
      await checkLayout(page, `${label}-3d-settings`, true);
      await page.getByRole("button", { name: "Caves" }).click();
      await expect
        .poll(() => page.evaluate(() => window.__mapelixViewer!.status.context?.mode))
        .toBe("caves");
      await checkLayout(page, `${label}-3d-caves-settings`, true);
      await page.keyboard.press("Escape");
      await checkLayout(page, `${label}-3d-caves`, false);
    }
  });

test("a tap outside closes a panel and the buttons keep their place across the switch", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page, `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=4`);
  const places = () =>
    page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll(".mx-left .mx-btn, .mx-right .mx-btn")].map((button) => {
          const box = button.getBoundingClientRect();
          return [
            button.getAttribute("aria-label")!.replace("Show the map", "Show in 3D"),
            [box.left, box.top],
          ];
        }),
      ),
    );
  const before = await places();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator(".mx-panel")).toBeVisible();
  const size = page.viewportSize()!;
  await page.mouse.click(size.width / 2, 40);
  await expect(page.locator(".mx-panel")).toBeHidden();
  await to3d(page);
  expect(await places()).toEqual(before);
});

test("the settings drive the 3D world: sky, time, go to, home, dimension, discoveries", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Same controls on both");
  test.setTimeout(120_000);
  await open(page, `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=4`);
  await to3d(page);
  const viewer = <T>(read: (v: MapelixViewer) => T) =>
    page.evaluate(`(${read.toString()})(window.__mapelixViewer)`) as Promise<T>;
  await page.getByRole("button", { name: "Settings" }).click();
  const panel = page.locator(".mx-panel");
  await panel.getByLabel("Clouds", { exact: true }).uncheck();
  await panel.getByLabel("Rain", { exact: true }).check();
  await panel.getByLabel("Thunderstorm", { exact: true }).check();
  expect(await viewer((v) => [v.settings.clouds, v.settings.weather])).toEqual([
    false,
    "thunderstorm",
  ]);
  await panel.getByLabel("Time of day", { exact: true }).fill("6");
  expect(await viewer((v) => v.settings.hour)).toBe(6);

  // Discoveries: shown only once switched on, then listed.
  expect(await viewer((v) => v.world!.snapshot().discoveries.enabled)).toBe(false);
  await panel.getByLabel("Show discoveries", { exact: true }).check();
  await expect.poll(() => viewer((v) => v.world!.snapshot().discoveries.enabled)).toBe(true);
  await expect(panel.locator("[data-part=filters]")).toBeVisible();

  // Go to coordinates.
  await panel.locator("input[name=x]").fill("100");
  await panel.locator("input[name=z]").fill("-20");
  await panel.getByRole("button", { name: "Go", exact: true }).click();
  await expect
    .poll(async () => {
      const view = await viewer((v) => v.view);
      return Math.hypot(view.x - 100, view.z + 20);
    })
    .toBeLessThan(2);

  // Home: the world spawn.
  await page.keyboard.press("Escape");
  const spawn = (await viewer((v) => v.status.spawn))!;
  await page.getByRole("button", { name: "Return home" }).click();
  await expect
    .poll(async () => {
      const view = await viewer((v) => v.view);
      return Math.hypot(view.x - spawn.x, view.z - spawn.z);
    })
    .toBeLessThan(2);

  // Dimension in 3D: the world reloads at the same place and stays 3D.
  await page.getByRole("button", { name: "Dimensions" }).click();
  await panel.getByRole("button", { name: "Nether" }).click();
  await expect.poll(() => viewer((v) => v.status.context?.dimension)).toBe("nether");
  expect(await viewer((v) => v.mode)).toBe("3d");
  // Sky settings do not apply in the Nether.
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(panel.getByLabel("Rain", { exact: true })).toBeDisabled();
  await expect(panel.getByText("Hide terrain from Y")).toBeVisible();
});
