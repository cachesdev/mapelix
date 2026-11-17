import { expect, test, type CDPSession, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import type { MapView, TileMap } from "@mapelix/viewer";

declare global {
  interface Window {
    __mapelixMap: TileMap | undefined;
  }
}

/** Over the fixture's stone platform, at the native zoom. */
const START = "/?dimension=overworld&x=40&z=8&scale=1";

async function ready(page: Page, url = START): Promise<void> {
  await page.goto(url);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const stats = window.__mapelixMap?.snapshot();
        return stats !== undefined && stats.wanted > 0 && stats.pending === 0;
      }),
    )
    .toBe(true);
}

const view = (page: Page) => page.evaluate(() => window.__mapelixMap!.view);

/** The block under a point of the page, from a view. */
function blockAt(page: Page, v: MapView, x: number, y: number) {
  const size = page.viewportSize()!;
  return {
    x: v.x + (x - size.width / 2) / v.pixelsPerBlock,
    z: v.z + (y - size.height / 2) / v.pixelsPerBlock,
  };
}

/** Waits until the view stops changing (animations and glides done). */
async function settle(page: Page): Promise<MapView> {
  let last = await view(page);
  for (;;) {
    await page.waitForTimeout(150);
    const next = await view(page);
    if (next.x === last.x && next.z === last.z && next.pixelsPerBlock === last.pixelsPerBlock)
      return next;
    last = next;
  }
}

type Point = { x: number; y: number };
const sessions = new WeakMap<Page, CDPSession>();

async function touch(
  page: Page,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: Point[],
): Promise<void> {
  // One session per page: the browser tracks the touch sequence per session.
  let session = sessions.get(page);
  if (session === undefined)
    sessions.set(page, (session = await page.context().newCDPSession(page)));
  await session.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((point, id) => ({ ...point, id })),
  });
}

/** A finger or mouse drag in `steps` moves, then a rest so no glide follows. */
async function drag(page: Page, from: Point, to: Point, touchscreen: boolean): Promise<void> {
  const steps = 10;
  const at = (i: number) => ({
    x: from.x + ((to.x - from.x) * i) / steps,
    y: from.y + ((to.y - from.y) * i) / steps,
  });
  if (touchscreen) await touch(page, "touchStart", [from]);
  else {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
  }
  for (let i = 1; i <= steps; i += 1) {
    if (touchscreen) await touch(page, "touchMove", [at(i)]);
    else await page.mouse.move(at(i).x, at(i).y);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  if (touchscreen) await touch(page, "touchEnd", []);
  else await page.mouse.up();
}

test("shows the map without page scroll, zoom or controls that hide it", async ({ page }) => {
  await ready(page);
  const layout = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll("button, .readout")].map((element) => {
      const box = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        w: box.width,
        h: box.height,
        l: box.left,
        r: box.right,
        t: box.top,
        b: box.bottom,
      };
    });
    return {
      boxes,
      scroll: document.scrollingElement!.scrollHeight - innerHeight,
      width: innerWidth,
      height: innerHeight,
    };
  });
  expect(layout.scroll).toBeLessThanOrEqual(0);
  const buttons = layout.boxes.filter((box) => box.tag === "BUTTON");
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  let covered = 0;
  for (const box of layout.boxes) {
    if (box.tag === "BUTTON") expect(Math.min(box.w, box.h)).toBeGreaterThanOrEqual(44);
    expect(box.l).toBeGreaterThanOrEqual(0);
    expect(box.r).toBeLessThanOrEqual(layout.width);
    expect(box.b).toBeLessThanOrEqual(layout.height);
    covered += box.w * box.h;
  }
  // Controls take a small share of even a phone screen.
  expect(covered / (layout.width * layout.height)).toBeLessThan(0.08);
  // Buttons do not overlap each other or the coordinates.
  for (const [i, a] of layout.boxes.entries())
    for (const b of layout.boxes.slice(i + 1))
      expect(a.r <= b.l || b.r <= a.l || a.b <= b.t || b.b <= a.t).toBe(true);
});

test("a drag moves the map with the pointer and a fling glides on", async ({ page }, info) => {
  const touchscreen = info.project.name === "phone";
  await ready(page);
  const before = await view(page);
  await drag(page, { x: 100, y: 300 }, { x: 260, y: 380 }, touchscreen);
  const after = await settle(page);
  expect(after.x).toBeCloseTo(before.x - 160 / before.pixelsPerBlock, 3);
  expect(after.z).toBeCloseTo(before.z - 80 / before.pixelsPerBlock, 3);

  // A quick flick keeps moving after release, then stops.
  if (touchscreen) await touch(page, "touchStart", [{ x: 300, y: 400 }]);
  else {
    await page.mouse.move(300, 400);
    await page.mouse.down();
  }
  for (let i = 1; i <= 5; i += 1) {
    if (touchscreen) await touch(page, "touchMove", [{ x: 300 - 30 * i, y: 400 }]);
    else await page.mouse.move(300 - 30 * i, 400);
    await page.waitForTimeout(16);
  }
  if (touchscreen) await touch(page, "touchEnd", []);
  else await page.mouse.up();
  const released = await view(page);
  const glided = await settle(page);
  expect(glided.x - released.x).toBeGreaterThan(20 / before.pixelsPerBlock);
  expect(await page.evaluate(() => [scrollX, scrollY, visualViewport!.scale])).toEqual([0, 0, 1]);
});

test("double tap or double click zooms in around the point", async ({ page }, info) => {
  await ready(page);
  const before = await view(page);
  const point = { x: 120, y: 260 };
  if (info.project.name === "phone") {
    for (let i = 0; i < 2; i += 1) {
      await touch(page, "touchStart", [point]);
      await page.waitForTimeout(40);
      await touch(page, "touchEnd", []);
      await page.waitForTimeout(80);
    }
  } else await page.mouse.dblclick(point.x, point.y);
  const after = await settle(page);
  expect(after.pixelsPerBlock).toBeCloseTo(before.pixelsPerBlock * 2, 6);
  const anchor = blockAt(page, before, point.x, point.y);
  const now = blockAt(page, after, point.x, point.y);
  expect(now.x).toBeCloseTo(anchor.x, 3);
  expect(now.z).toBeCloseTo(anchor.z, 3);
  expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
});

test("a pinch zooms around the fingers", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "Two-finger touch");
  await ready(page);
  const before = await view(page);
  const middle = { x: 180, y: 420 };
  const fingers = (spread: number) => [
    { x: middle.x - spread / 2, y: middle.y },
    { x: middle.x + spread / 2, y: middle.y },
  ];
  await touch(page, "touchStart", fingers(100));
  for (let spread = 110; spread <= 250; spread += 10) {
    await touch(page, "touchMove", fingers(spread));
    await page.waitForTimeout(16);
  }
  await touch(page, "touchEnd", []);
  const after = await settle(page);
  expect(after.pixelsPerBlock).toBeCloseTo(before.pixelsPerBlock * 2.5, 3);
  const anchor = blockAt(page, before, middle.x, middle.y);
  const now = blockAt(page, after, middle.x, middle.y);
  expect(now.x).toBeCloseTo(anchor.x, 2);
  expect(now.z).toBeCloseTo(anchor.z, 2);
  expect(await page.evaluate(() => [scrollY, visualViewport!.scale])).toEqual([0, 1]);
});

test("the wheel and keys zoom and move with animation", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "Mouse wheel and keyboard");
  await ready(page);
  const before = await view(page);
  await page.mouse.move(300, 200);
  await page.mouse.wheel(0, -200);
  const zoomed = await settle(page);
  expect(zoomed.pixelsPerBlock).toBeCloseTo(before.pixelsPerBlock * 2, 3);
  const anchor = blockAt(page, before, 300, 200);
  expect(blockAt(page, zoomed, 300, 200).x).toBeCloseTo(anchor.x, 2);

  // The map layer holds the keyboard focus; its canvas carries the label.
  await page.locator('canvas[aria-label="World map"]').locator("..").focus();
  await page.keyboard.press("ArrowRight");
  const moved = await settle(page);
  expect(moved.x).toBeGreaterThan(zoomed.x);
  await page.keyboard.press("-");
  expect((await settle(page)).pixelsPerBlock).toBeCloseTo(zoomed.pixelsPerBlock / 2, 6);
});

test("enlarged tiles keep sharp block edges", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "One device pixel ratio is enough");
  await ready(page, "/?dimension=overworld&x=40&z=8&scale=8");
  // 8 px per block from 4 px tiles: within a row, color only changes on block edges.
  const changes = await page.evaluate(() => {
    const canvas = document.querySelector("canvas")!;
    const data = canvas.getContext("2d")!.getImageData(0, canvas.height / 2, canvas.width, 1).data;
    let changes = 0;
    for (let i = 4; i < data.length; i += 4)
      if (data[i] !== data[i - 4] || data[i + 1] !== data[i - 3] || data[i + 2] !== data[i - 2])
        changes += 1;
    return { changes, width: canvas.width };
  });
  expect(changes.changes).toBeLessThanOrEqual(changes.width / 8 + 2);
});

test("tiles load from the middle and requests that leave the screen are cancelled", async ({
  page,
}) => {
  const order: string[] = [];
  const aborted: string[] = [];
  await page.route("**/generations/**", async (route) => {
    order.push(new URL(route.request().url()).pathname);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue().catch(() => undefined);
  });
  page.on("requestfailed", (request) => {
    if (request.url().includes("/generations/")) aborted.push(request.url());
  });
  await page.goto("/?dimension=overworld&x=40&z=8&scale=0.25");
  await expect.poll(() => order.length).toBeGreaterThan(0);
  const first = order[0]!.match(/tiles\/(-?\d+)\/(-?\d+)\/(-?\d+)\.png$/)!;
  const span = 256 / 2 ** Number(first[1]);
  // The first request is the tile under the middle of the screen.
  expect(Math.floor(40 / span)).toBe(Number(first[2]));
  expect(Math.floor(8 / span)).toBe(Number(first[3]));
  // Jump far away before those answers arrive.
  await page.evaluate(() => window.__mapelixMap!.setView({ x: 900000, z: 900000 }, false));
  await expect.poll(() => aborted.length).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__mapelixMap!.snapshot().loading)).toBe(0);
});

test("first display time compared with Leaflet on the same export", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "Timed once, on desktop");
  test.setTimeout(180_000);
  const require = createRequire(import.meta.url);
  const leafletJs = await readFile(require.resolve("leaflet/dist/leaflet.js"), "utf8");
  const leafletCss = await readFile(require.resolve("leaflet/dist/leaflet.css"), "utf8");
  const baseline = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/leaflet.css">
<style>html,body,#map{margin:0;height:100%}</style></head><body><div id="map"></div>
<script src="/leaflet.js"></script><script>
(async () => {
  const response = await fetch("/tiles/manifest.json", { cache: "no-cache" });
  const manifest = await response.json();
  const base = new URL(manifest.tileBase, new URL("/tiles/manifest.json", location.href));
  const map = L.map("map", { crs: L.CRS.Simple, minZoom: -4, maxZoom: 5, zoomSnap: 1 });
  const Layer = L.TileLayer.extend({
    getTileUrl: (c) => new URL("overworld/tiles/" + c.z + "/" + c.x + "/" + c.y + ".png", base).href,
  });
  const layer = new Layer("", { minNativeZoom: -4, maxNativeZoom: 2, minZoom: -4, maxZoom: 5, tileSize: 256, errorTileUrl: "" });
  layer.on("load", () => { window.__done ??= performance.now(); });
  layer.addTo(map);
  // The middle of every overworld tile, as the Mapelix map opens by default.
  let west = Infinity, north = Infinity, east = -Infinity, south = -Infinity;
  for (const t of manifest.tiles) if (t.dimension === "overworld") {
    const span = 256 / 2 ** t.z;
    west = Math.min(west, t.x * span); north = Math.min(north, t.y * span);
    east = Math.max(east, (t.x + 1) * span); south = Math.max(south, (t.y + 1) * span);
  }
  map.setView([-(north + south) / 2, (west + east) / 2], 0);
})();
</script></body></html>`;

  // The same map without the demo application around it, to compare the libraries alone.
  const plain = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body,#map{margin:0;height:100%}</style></head><body><div id="map"></div>
<script type="module">
import { TileIndex, TileMap } from "/viewer/index.js";
const url = new URL("/tiles/manifest.json", location.href);
const index = new TileIndex(await (await fetch(url)).json(), url);
new TileMap(document.getElementById("map"), {
  index,
  dimension: "overworld",
  view: { pixelsPerBlock: 1 },
  onIdle: () => { window.__done ??= performance.now(); },
});
</script></body></html>`;
  const dist = resolve("node_modules/@mapelix/viewer/dist");
  const timings = { mapelix: [] as number[], plain: [] as number[], leaflet: [] as number[] };
  for (let run = 0; run < 5; run += 1) {
    for (const kind of ["mapelix", "plain", "leaflet"] as const) {
      // A new context each time: nothing cached.
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.route("**/leaflet-baseline", (route) =>
        route.fulfill({ contentType: "text/html", body: baseline }),
      );
      await page.route("**/leaflet.js", (route) =>
        route.fulfill({ contentType: "text/javascript", body: leafletJs }),
      );
      await page.route("**/mapelix-plain", (route) =>
        route.fulfill({ contentType: "text/html", body: plain }),
      );
      await page.route("**/viewer/**", async (route) =>
        route.fulfill({
          contentType: "text/javascript",
          body: await readFile(join(dist, new URL(route.request().url()).pathname.slice(8))),
        }),
      );
      await page.route("**/leaflet.css", (route) =>
        route.fulfill({ contentType: "text/css", body: leafletCss }),
      );
      if (kind !== "mapelix") {
        await page.goto(kind === "leaflet" ? "/leaflet-baseline" : "/mapelix-plain");
        const done = await page.waitForFunction(() => Reflect.get(window, "__done") as number);
        timings[kind].push((await done.jsonValue()) as number);
      } else {
        await page.goto("/?dimension=overworld&scale=1");
        // Recorded by the map when the last needed tile is drawn, like Leaflet's "load".
        const done = await page.waitForFunction(
          () => Reflect.get(window, "__mapelixIdleAt") as number,
        );
        timings.mapelix.push((await done.jsonValue()) as number);
      }
      await context.close();
    }
  }
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[2]!;
  const result = {
    mapelix: median(timings.mapelix),
    plain: median(timings.plain),
    leaflet: median(timings.leaflet),
  };
  info.annotations.push({
    type: "first display (ms, median of 5)",
    description: JSON.stringify(result),
  });
  console.log(`First display, median of 5: ${JSON.stringify(result)} ${JSON.stringify(timings)}`);
  expect(result.mapelix).toBeLessThan(result.leaflet * 1.5 + 100);
});
