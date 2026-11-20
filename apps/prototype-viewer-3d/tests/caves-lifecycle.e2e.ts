import { expect, test } from "@playwright/test";
import type { WorldInfo, WorldViewer } from "@mapelix/viewer/three";

interface Sample {
  index: number;
  memory: { uniformBuffers: number; textures: number; total: number };
  pooled: number;
  heap?: number;
  discoveryBytes: number;
  markers: number;
}
declare global {
  interface Window {
    __undergroundViewer: WorldViewer | undefined;
    __undergroundSample(sample: Sample): Promise<void>;
  }
}

test("104 real view switches retain bounded GPU/CPU resources and release the renderer", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(300_000);
  test.skip(
    Boolean(process.env.MAPELIX_E2E_WORLD_DIRECTORY),
    "The real snapshot has no End; all four views use generated terrain here",
  );
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const contexts = [
    "dimension=overworld",
    "dimension=overworld&mode=caves&minY=-64&maxY=-32",
    "dimension=nether",
    "dimension=the-end",
  ];
  const worlds: WorldInfo[] = [];
  for (const query of contexts) {
    const response = await request.get(`/world.json?${query}`);
    expect(response.ok()).toBe(true);
    worlds.push(await response.json());
  }
  await page.route("**/underground-lifecycle", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:960px;height:640px"></div></body></html>',
    }),
  );
  await page.goto("/underground-lifecycle");
  const cdp = await page.context().newCDPSession(page),
    samples: Sample[] = [];
  await page.exposeBinding("__undergroundSample", async (_, sample: Sample) => {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    sample.heap = heap.usedSize;
    samples.push(sample);
  });
  const backend = await page.evaluate(async (worlds) => {
    const modulePath = "/src/lib/world-viewer.ts";
    const { WorldViewer } = await import(modulePath);
    const viewer: WorldViewer = await WorldViewer.create(
      document.getElementById("viewer")!,
      worlds[0],
      { x: 16, y: 80, z: 16, distance: 80, pitch: 0.8, heading: 0.4 },
      { weather: "thunderstorm" },
    );
    window.__undergroundViewer = viewer;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let index = 0; index < 104; index++) {
      // Also exercise disposal when the reuse pool cannot retain any more shells.
      // This catches shader-binding retention hidden by a small, repeatedly reused scene.
      if (index === 52) Reflect.set(Reflect.get(viewer, "meshPool"), "capacity", 0);
      const world = worlds[index % 4]!;
      viewer.setWorld(
        { ...world, spawn: { x: 16, y: world.mode === "caves" ? -48 : 80, z: 16 } },
        false,
      );
      viewer.zoom(0.5);
      viewer.setRenderDistance(128);
      const caves = world.mode === "caves";
      viewer.setSelection(caves ? { minX: 0, maxX: 32, minZ: 0, maxZ: 32 } : undefined);
      viewer.setSelectionTool(
        caves ? (Math.floor(index / 4) % 2 === 0 ? "move" : "resize") : "off",
      );
      viewer.setDiscoveryFilters({
        enabled: caves,
        categories: ["spawners", "containers", "vaults", "amethyst", "sculk", "landmarks"],
        ores: [],
        exposure: "all",
        allHeights: false,
      });
      const start = performance.now();
      while (true) {
        const stats = viewer.snapshot().streaming;
        const discoveries = viewer.snapshot().discoveries;
        if (
          !stats.loading &&
          !stats.remaining &&
          stats.quads &&
          (!caves ||
            (!discoveries.loading &&
              !discoveries.remaining &&
              !discoveries.grouping &&
              discoveries.groups.length > 0))
        )
          break;
        if (performance.now() - start > 25_000)
          throw new Error(`Terrain timeout at switch ${index}`);
        await pause(25);
      }
      await pause(550);
      if (index % 4 === 3) {
        const renderer = Reflect.get(viewer, "renderer") as { info: { memory: Sample["memory"] } };
        const pool = Reflect.get(viewer, "meshPool") as { retained: number };
        await window.__undergroundSample({
          index,
          memory: { ...renderer.info.memory },
          pooled: pool.retained,
          discoveryBytes: viewer.snapshot().discoveries.bytes,
          markers: document.querySelectorAll('[aria-label="Discovery markers"] button').length,
        });
      }
    }
    const backend = viewer.backend;
    viewer.dispose();
    window.__undergroundViewer = undefined;
    return backend;
  }, worlds);
  expect(samples).toHaveLength(26);
  await testInfo.attach("underground-lifecycle", {
    body: JSON.stringify(
      { backend, project: testInfo.project.name, switches: 104, samples, errors },
      null,
      2,
    ),
    contentType: "application/json",
  });
  const warm = samples.filter((s) => s.index >= 19),
    first = warm[0]!,
    last = warm.at(-1)!;
  expect(last.memory.uniformBuffers).toBeLessThanOrEqual(first.memory.uniformBuffers + 8);
  expect(last.memory.textures).toBeLessThanOrEqual(first.memory.textures + 1);
  expect(last.memory.total).toBeLessThanOrEqual(first.memory.total + 1024 * 1024);
  expect(last.heap! - first.heap!).toBeLessThan(2 * 1024 * 1024);
  const disposing = warm.filter((sample) => sample.index >= 67);
  expect(last.heap! - disposing[0]!.heap!).toBeLessThan(512 * 1024);
  expect(last.pooled).toBeLessThanOrEqual(5 * 64);
  expect(errors).toEqual([]);
  await expect(page.locator("canvas")).toHaveCount(0);
  await expect(page.locator('[aria-label="Discovery markers"]')).toHaveCount(0);
  expect(
    samples.every((sample) => sample.discoveryBytes <= 4 * 1024 * 1024 && sample.markers <= 128),
  ).toBe(true);
});
