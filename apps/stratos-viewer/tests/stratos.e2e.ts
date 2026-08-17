import { expect, test } from "@playwright/test";

test("renders the real Stratos world", async ({ page }) => {
  const expectColdCache = process.env.MAPELIX_EXPECT_COLD_CACHE === "1";
  const initialTileCacheStatuses: string[] = [];
  page.on("response", (response) => {
    if (/\/tiles\/0\/-?\d+\/-?\d+\.png$/.test(response.url())) {
      const status = response.headers()["x-mapelix-cache"];
      if (status !== undefined) initialTileCacheStatuses.push(status);
    }
  });
  const metadataResponse = page.waitForResponse((response) =>
    response.url().endsWith("/world.json"),
  );
  await page.goto("/");

  const metadata = await metadataResponse;
  expect(metadata.ok()).toBe(true);
  if (expectColdCache) {
    expect(metadata.headers()["x-mapelix-cache"]).toBe("index");
  } else {
    expect(["disk", "index", "memory"]).toContain(metadata.headers()["x-mapelix-cache"]);
  }

  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  if (expectColdCache) expect(initialTileCacheStatuses).toContain("render");
  const cachedTile = await page.request.get("/tiles/0/-13/-12.png");
  expect(cachedTile.ok()).toBe(true);
  expect(cachedTile.headers()["x-mapelix-cache"]).toBe("memory");
  await expect(page).toHaveScreenshot("stratos-viewer.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });

  const detailedTile = page.waitForResponse(
    (response) => /\/tiles\/2\/-?\d+\/-?\d+\.png$/.test(response.url()),
    { timeout: 120_000 },
  );
  await page.locator(".leaflet-control-zoom-in").click();
  await expect(page.getByText("+1", { exact: true })).toBeVisible();
  await page.locator(".leaflet-control-zoom-in").click();
  await expect(page.getByText("+2", { exact: true })).toBeVisible();
  expect((await detailedTile).ok()).toBe(true);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("stratos-detail.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });

  const maximumDetailTile = page.waitForResponse(
    (response) => /\/tiles\/3\/-?\d+\/-?\d+\.png$/.test(response.url()),
    { timeout: 120_000 },
  );
  await page.locator(".leaflet-control-zoom-in").click();
  await expect(page.getByText("+3", { exact: true })).toBeVisible();
  expect((await maximumDetailTile).ok()).toBe(true);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("stratos-detail-max.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });

  const flatLightingTile = page.waitForResponse(
    (response) => response.url().endsWith("/tiles/3/-93/-83.png"),
    { timeout: 120_000 },
  );
  await page.getByLabel("X", { exact: true }).fill("-2950");
  await page.getByLabel("Z", { exact: true }).fill("-2630");
  await page.getByRole("button", { name: "Locate" }).click();
  expect((await flatLightingTile).ok()).toBe(true);
  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page).toHaveScreenshot("stratos-flat-lighting.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});

test("keeps Stratos shadows continuous across native tile boundaries", async ({
  page,
  request,
}) => {
  const cases = [
    { axis: "x", zoom: 1, firstX: -24, firstY: -25 },
    { axis: "x", zoom: 2, firstX: -47, firstY: -49 },
    { axis: "x", zoom: 3, firstX: -93, firstY: -98 },
    { axis: "z", zoom: 1, firstX: -24, firstY: -25 },
    { axis: "z", zoom: 2, firstX: -47, firstY: -49 },
    { axis: "z", zoom: 3, firstX: -93, firstY: -98 },
  ] as const;

  for (const seam of cases) {
    const secondX = seam.firstX + (seam.axis === "x" ? 1 : 0);
    const secondY = seam.firstY + (seam.axis === "z" ? 1 : 0);
    const [first, second] = await Promise.all([
      tileDataUrl(request, seam.zoom, seam.firstX, seam.firstY),
      tileDataUrl(request, seam.zoom, secondX, secondY),
    ]);
    await page.setContent(seamStrip(first, second, seam.axis));
    await expect(page.locator("#seam")).toHaveScreenshot(
      `stratos-seam-${seam.axis}-z${seam.zoom}.png`,
      { animations: "disabled", maxDiffPixels: 0 },
    );
  }
});

async function tileDataUrl(
  request: import("@playwright/test").APIRequestContext,
  zoom: number,
  x: number,
  y: number,
): Promise<string> {
  const response = await request.get(`/tiles/${zoom}/${x}/${y}.png`);
  expect(response.ok()).toBe(true);
  return `data:image/png;base64,${(await response.body()).toString("base64")}`;
}

function seamStrip(first: string, second: string, axis: "x" | "z"): string {
  const horizontal = axis === "x";
  const width = horizontal ? 32 : 256;
  const height = horizontal ? 256 : 32;
  const flow = horizontal ? "row" : "column";
  const translate = horizontal ? "translateX(-240px)" : "translateY(-240px)";
  return `<!doctype html>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; background: transparent; }
      #seam { width: ${width}px; height: ${height}px; overflow: hidden; }
      #tiles { display: flex; flex-direction: ${flow}; transform: ${translate}; }
      img { display: block; width: 256px; height: 256px; image-rendering: pixelated; flex: none; }
    </style>
    <div id="seam"><div id="tiles"><img src="${first}"><img src="${second}"></div></div>`;
}
