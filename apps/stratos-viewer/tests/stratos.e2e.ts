import { expect, test } from "@playwright/test";

test("renders the real Stratos world", async ({ page }) => {
  const metadataResponse = page.waitForResponse((response) =>
    response.url().endsWith("/world.json"),
  );
  await page.goto("/");

  const metadata = await metadataResponse;
  expect(metadata.ok()).toBe(true);
  expect(["disk", "index", "memory"]).toContain(metadata.headers()["x-mapelix-cache"]);

  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
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
