import { expect, test } from "@playwright/test";

test("launches Chromium and displays the harness", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Mapelix" })).toBeVisible();
});
