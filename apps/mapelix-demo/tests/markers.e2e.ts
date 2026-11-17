import { expect, test, type CDPSession, type Page } from "@playwright/test";
import type { MapelixViewer, MarkerInput } from "@mapelix/viewer";
import { WORLD_URL } from "../playwright.config";

declare global {
  interface Window {
    __mapelixViewer: MapelixViewer | undefined;
    __markerClicks: string[] | undefined;
  }
}

/** Over the fixture's stone platform, below the switch scale. */
const START = `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=4`;

type Point = { x: number; y: number };
type Stats = {
  elements: number;
  clusters: number;
  labels: number;
  visible: number;
  lastUpdateMs: number;
  maxUpdateMs: number;
};
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

async function tap(page: Page, point: Point, phone: boolean): Promise<void> {
  if (phone) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
}

async function open(page: Page, url = START): Promise<void> {
  await page.goto(url);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer?.map.snapshot().pending === 0))
    .toBe(true);
  // The demo's example markers arrive first; the tests then replace them.
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.markers.list().length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const viewer = window.__mapelixViewer!;
    window.__markerClicks = [];
    viewer.markers.onClick((event) => window.__markerClicks!.push(event.marker.id));
  });
}

async function setMarkers(page: Page, markers: MarkerInput[]): Promise<void> {
  await page.evaluate((list) => window.__mapelixViewer!.markers.set(list), markers);
  await page.waitForTimeout(100);
}

/** Center of a marker or group on screen, by its accessible name. */
async function markerAt(page: Page, name: string): Promise<Point | undefined> {
  return page.evaluate((label) => {
    for (const element of document.querySelectorAll(".mx-marker"))
      if (element.getAttribute("aria-label") === label && element.isConnected) {
        const box = element.querySelector(".mx-marker-icon")!.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }
    return undefined;
  }, name);
}

async function stats(page: Page): Promise<Stats> {
  return page.evaluate(() =>
    (window.__mapelixViewer!.markers as unknown as { stats(): Stats }).stats(),
  );
}

async function to3d(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Show in 3D" }).click();
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.mode), { timeout: 20_000 })
    .toBe("3d");
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.status.loading), { timeout: 30_000 })
    .toBe(0);
  await page.waitForTimeout(300);
}

test("a marker shows at the same place on the map, in isometric 3D and in perspective", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await open(page);
  await setMarkers(page, [{ id: "a", x: 46, z: 14, label: "Alpha", icon: "A" }]);
  const flat = (await markerAt(page, "Alpha"))!;
  expect(flat).toBeDefined();
  // 2D: the block center, from the view center at 4 px per block.
  const size = page.viewportSize()!;
  expect(Math.abs(flat.x - (size.width / 2 + (46.5 - 40) * 4))).toBeLessThan(1.5);
  expect(Math.abs(flat.y - (size.height / 2 + (14.5 - 8) * 4))).toBeLessThan(1.5);

  await page.evaluate(() => window.__mapelixViewer!.zoomBy(1.5));
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.mode), { timeout: 20_000 })
    .toBe("3d");
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.status.loading), { timeout: 30_000 })
    .toBe(0);
  await page.waitForTimeout(400);
  const view = await page.evaluate(() => window.__mapelixViewer!.view);
  const expected = {
    x: size.width / 2 + (46.5 - view.x) * view.pixelsPerBlock,
    y: size.height / 2 + (14.5 - view.z) * view.pixelsPerBlock,
  };
  const iso = (await markerAt(page, "Alpha"))!;
  // Straight down, isometric: the terrain height moves it only a little.
  expect(Math.hypot(iso.x - expected.x, iso.y - expected.y)).toBeLessThan(8);

  await page.evaluate(() => window.__mapelixViewer!.setProjection("perspective"));
  await page.waitForTimeout(1200);
  const perspective = (await markerAt(page, "Alpha"))!;
  // The 3D engine's own projection of the marker point.
  const projected = await page.evaluate(() => {
    const viewer = window.__mapelixViewer!;
    const world = viewer.world!;
    const y = (world.surfaceHeightAt(46, 14) ?? 63) + 1;
    return world.projectToScreen(46.5, y, 14.5);
  });
  expect(projected).toBeDefined();
  expect(Math.hypot(perspective.x - projected!.x, perspective.y - projected!.y)).toBeLessThan(1.5);
  expect(Math.hypot(perspective.x - expected.x, perspective.y - expected.y)).toBeLessThan(40);
});

test("a tap selects a marker and reports it; a drag that starts on a marker moves the view", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await open(page);
  await setMarkers(page, [
    { id: "a", x: 46, z: 14, label: "Alpha", icon: "A", data: { any: "thing" } },
    { id: "b", x: 20, z: -20, label: "Bravo", icon: "B" },
  ]);
  const alpha = (await markerAt(page, "Alpha"))!;
  // A tap a few pixels off the center still hits.
  await tap(page, { x: alpha.x + 6, y: alpha.y - 5 }, phone);
  await expect.poll(() => page.evaluate(() => window.__markerClicks)).toEqual(["a"]);
  expect(await page.evaluate(() => window.__mapelixViewer!.markers.selected?.id)).toBe("a");
  await expect(page.locator(".mx-marker[aria-current]")).toHaveAttribute("aria-label", "Alpha");
  // The tap leaves the keys with the view.
  expect(
    await page.evaluate(() => document.activeElement?.closest(".mx-marker") ?? null),
  ).toBeNull();

  const before = await page.evaluate(() => window.__mapelixViewer!.view);
  await drag(page, alpha, { x: alpha.x - 120, y: alpha.y - 60 }, phone);
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__mapelixViewer!.view);
  expect(after.x - before.x).toBeGreaterThan(20);
  expect(after.z - before.z).toBeGreaterThan(10);
  expect(await page.evaluate(() => window.__markerClicks)).toEqual(["a"]);

  // A tap on empty ground clears the selection.
  await tap(page, { x: 30, y: page.viewportSize()!.height / 2 }, phone);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.markers.selected))
    .toBeUndefined();

  if (!phone) {
    // From the keyboard: Tab to a marker, Enter reports it.
    await page.locator('.mx-marker[aria-label="Bravo"]').focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.evaluate(() => window.__markerClicks)).toEqual(["a", "b"]);
  }
});

test("labels never overlap; markers group when zoomed out and a group tap zooms in", async ({
  page,
}, info) => {
  const phone = info.project.name === "phone";
  await open(page, `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=1`);
  const markers: MarkerInput[] = [];
  for (let i = 0; i < 80; i += 1)
    markers.push({
      id: `m${i}`,
      x: 40 + ((i * 37) % 160) - 80,
      z: 8 + ((i * 53) % 200) - 100,
      label: `Place number ${i}`,
      icon: String(i % 10),
      group: i % 2 ? "odd" : "even",
    });
  await setMarkers(page, markers);
  const check = async () => {
    const result = await page.evaluate(() => {
      const box = (element: Element) => element.getBoundingClientRect();
      const icons = [...document.querySelectorAll(".mx-marker-icon")].map(box);
      const labels = [...document.querySelectorAll(".mx-marker")]
        .map((element) => element.querySelector(".mx-marker-label") as HTMLElement)
        .filter((label) => label.style.visibility !== "hidden")
        .map(box);
      const controls = [...document.querySelectorAll(".mx-ui .mx-btn, .mx-ui .mx-readout")]
        .filter((element) => element.checkVisibility({ visibilityProperty: true }))
        .map(box);
      const overlap = (a: DOMRect, b: DOMRect) =>
        a.left < b.right - 0.5 &&
        b.left < a.right - 0.5 &&
        a.top < b.bottom - 0.5 &&
        b.top < a.bottom - 0.5;
      let bad = 0;
      for (const [i, a] of labels.entries()) {
        for (const b of labels.slice(i + 1)) if (overlap(a, b)) bad += 1;
        for (const b of icons) if (overlap(a, b)) bad += 1;
        for (const b of controls) if (overlap(a, b)) bad += 1;
        if (a.left < 0 || a.top < 0 || a.right > innerWidth || a.bottom > innerHeight) bad += 1;
      }
      let close = 0;
      const centers = icons.map((b) => [b.left + b.width / 2, b.top + b.height / 2]);
      for (const [i, a] of centers.entries())
        for (const b of centers.slice(i + 1))
          if (Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) < 47) close += 1;
      return { bad, close, labels: labels.length };
    });
    expect(result.bad).toBe(0);
    expect(result.close).toBe(0);
    return result;
  };
  await check();
  // Zoomed out: groups, still no overlap.
  await page.evaluate(() => window.__mapelixViewer!.map.setView({ pixelsPerBlock: 0.25 }, false));
  await page.waitForTimeout(300);
  const zoomedOut = await stats(page);
  expect(zoomedOut.clusters).toBeGreaterThan(0);
  expect(zoomedOut.elements).toBeLessThan(80);
  await check();
  // A tap on a group zooms in on it.
  const group = await page.evaluate(() => {
    const element = document.querySelector('.mx-marker[data-kind="cluster"]')!;
    const box = element.querySelector(".mx-marker-icon")!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await tap(page, group, phone);
  await expect
    .poll(() => page.evaluate(() => window.__mapelixViewer!.view.pixelsPerBlock))
    .toBeCloseTo(0.5, 2);
  // Groups of markers the host hides go away.
  await page.evaluate(() => window.__mapelixViewer!.markers.setGroupVisible("odd", false));
  await page.waitForTimeout(100);
  expect((await stats(page)).visible).toBeLessThanOrEqual(40);
});

test("labels are text, images only load from http(s) or relative addresses", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "Same code on both");
  await open(page);
  await setMarkers(page, [
    {
      id: "x",
      x: 40,
      z: 8,
      label: '<img src=x onerror="window.__owned=1">',
      image: "javascript:alert(1)",
    },
    { id: "y", x: 60, z: 8, label: "Flag", image: "/markers/flag.svg" },
  ]);
  const result = await page.evaluate(() => {
    const labels = [...document.querySelectorAll(".mx-marker-label")];
    return {
      text: labels.map((label) => label.textContent),
      imagesInLabels: labels.reduce((n, label) => n + label.querySelectorAll("*").length, 0),
      images: [...document.querySelectorAll(".mx-marker img")].map((image) =>
        image.getAttribute("src"),
      ),
      owned: Reflect.get(window, "__owned"),
    };
  });
  expect(result.text).toContain('<img src=x onerror="window.__owned=1">');
  expect(result.imagesInLabels).toBe(0);
  expect(result.images).toEqual(["/markers/flag.svg"]);
  expect(result.owned).toBeUndefined();
});

/** Frame intervals and marker update times during `gesture`. */
async function measure(page: Page, gesture: () => Promise<void>) {
  await page.evaluate(() => {
    const markers = window.__mapelixViewer!.markers as unknown as {
      stats(): Stats;
      resetStats(): void;
    };
    markers.resetStats();
    const record = {
      frames: [] as number[],
      updates: [] as number[],
      last: performance.now(),
      running: true,
    };
    Reflect.set(window, "__record", record);
    const step = (now: number) => {
      if (!record.running) return;
      record.frames.push(now - record.last);
      record.last = now;
      record.updates.push(markers.stats().lastUpdateMs);
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  await gesture();
  return page.evaluate(() => {
    const record = Reflect.get(window, "__record") as {
      frames: number[];
      updates: number[];
      running: boolean;
    };
    record.running = false;
    const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
    const at = (values: number[], q: number) =>
      sorted(values)[Math.min(values.length - 1, Math.floor(values.length * q))] ?? 0;
    const markers = window.__mapelixViewer!.markers as unknown as { stats(): Stats };
    return {
      frames: record.frames.length,
      frameP50: at(record.frames, 0.5),
      frameP95: at(record.frames, 0.95),
      updateP95: at(record.updates, 0.95),
      updateMax: markers.stats().maxUpdateMs,
      elements: markers.stats().elements,
    };
  });
}

test("1,000 markers: the map and the 3D view stay smooth while moving and zooming", async ({
  page,
}, info) => {
  test.setTimeout(150_000);
  const phone = info.project.name === "phone";
  await open(page, `${WORLD_URL}/?dimension=overworld&x=40&z=8&scale=2`);
  let seed = 99;
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  const markers: MarkerInput[] = [];
  for (let i = 0; i < 1000; i += 1)
    markers.push({
      id: `p${i}`,
      x: Math.round(40 + (random() - 0.5) * 1600),
      z: Math.round(8 + (random() - 0.5) * 1600),
      label: `Point ${i}`,
      icon: String(i % 100),
      color: ["#2f86c4", "#e0a526", "#8a4fd6"][i % 3]!,
      group: `g${i % 3}`,
      priority: i % 7,
    });
  await setMarkers(page, markers);
  // A phone CPU is several times slower than a desktop one.
  if (phone) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  const size = page.viewportSize()!;
  const center = { x: size.width / 2, y: size.height / 2 };
  const pan = async () => {
    for (let i = 0; i < 3; i += 1) {
      await drag(page, center, { x: center.x - 140, y: center.y - 90 }, phone, 20);
      await drag(page, center, { x: center.x + 140, y: center.y + 90 }, phone, 20);
    }
  };
  const zoom = async () => {
    for (const factor of [0.5, 0.5, 2, 2]) {
      await page.evaluate((f) => window.__mapelixViewer!.zoomBy(f), factor);
      await page.waitForTimeout(350);
    }
  };
  const flat = await measure(page, async () => {
    await pan();
    await zoom();
  });
  info.annotations.push({ type: "2d", description: JSON.stringify(flat) });
  console.log(`[markers ${info.project.name}] 2d`, JSON.stringify(flat));
  expect(flat.elements).toBeLessThan(250);
  expect(flat.updateP95).toBeLessThan(4);
  expect(flat.frameP50).toBeLessThan(25);

  await page.evaluate(() =>
    window.__mapelixViewer!.map.setView({ x: 40, z: 8, pixelsPerBlock: 4 }, false),
  );
  await to3d(page);
  for (const projection of ["isometric", "perspective"] as const) {
    await page.evaluate((p) => window.__mapelixViewer!.setProjection(p), projection);
    await page.waitForTimeout(800);
    const world = await measure(page, pan);
    info.annotations.push({ type: `3d-${projection}`, description: JSON.stringify(world) });
    console.log(`[markers ${info.project.name}] 3d ${projection}`, JSON.stringify(world));
    expect(world.elements).toBeLessThan(250);
    expect(world.updateP95).toBeLessThan(4);
  }
  // The same gesture without markers, for comparison in the report.
  await page.evaluate(() => window.__mapelixViewer!.markers.clear());
  const empty = await measure(page, pan);
  info.annotations.push({ type: "3d-perspective-no-markers", description: JSON.stringify(empty) });
  console.log(`[markers ${info.project.name}] 3d perspective, no markers`, JSON.stringify(empty));
  // Again with the markers, over terrain already loaded like the run without them.
  await setMarkers(page, markers);
  const again = await measure(page, pan);
  info.annotations.push({ type: "3d-perspective-again", description: JSON.stringify(again) });
  console.log(
    `[markers ${info.project.name}] 3d perspective, markers again`,
    JSON.stringify(again),
  );
  expect(again.updateP95).toBeLessThan(4);
});
