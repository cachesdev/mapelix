import { expect, test } from "@playwright/test";

test("shows the real generated Bedrock tile", async ({ page }) => {
  await page.goto("/");
  const tile = page.getByRole("img", { name: "Generated Minecraft map tile" });
  await expect(tile).toBeVisible();
  await expect(tile).toHaveJSProperty("naturalWidth", 256);
  await expect(tile).toHaveJSProperty("naturalHeight", 256);
  await expect(page.locator("#tile-frame")).toHaveScreenshot("prototype-tile.png");
});
