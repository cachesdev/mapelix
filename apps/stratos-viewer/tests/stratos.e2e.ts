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
});
