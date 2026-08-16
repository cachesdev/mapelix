import { expect, test } from "@playwright/test";

test("renders the real Stratos world", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("Ready", { exact: true })).toBeVisible();
  await expect(page.locator(".leaflet-tile-loaded").first()).toBeVisible();
  await expect(page).toHaveScreenshot("stratos-viewer.png", {
    animations: "disabled",
    maxDiffPixelRatio: 0.01,
  });
});
