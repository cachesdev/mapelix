import { expect, test } from "@playwright/test";

test("models and lava compile on the GPU and lava animates with a stationary camera", async ({
  page,
}, testInfo) => {
  test.skip(
    Boolean(process.env.MAPELIX_E2E_WORLD_DIRECTORY),
    "The close-up coordinates belong to the generated catalog",
  );
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/?dimension=nether&x=46&y=80&z=18&distance=42&heading=25&pitch=60");
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 45_000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  const canvas = await page.locator("canvas").boundingBox();
  const clip = {
    x: canvas!.x + canvas!.width * 0.35,
    y: canvas!.y + canvas!.height * 0.4,
    width: canvas!.width * 0.3,
    height: canvas!.height * 0.25,
  };
  const view = page.url();
  const first = await page.screenshot({ clip });
  await page.waitForTimeout(1200);
  const second = await page.screenshot({ clip });
  expect(page.url()).toBe(view);
  expect(second.equals(first)).toBe(false);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-lava-closeup.png` });
  await page.goto("/?dimension=overworld&x=15&y=80&z=30&distance=48&heading=30&pitch=55");
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-models-closeup.png` });
  await page.goto("/?dimension=the-end&x=13&y=81&z=52&distance=27&heading=25&pitch=45");
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 45_000 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `test-results/${testInfo.project.name}-connections-closeup.png` });
  expect(errors).toEqual([]);
});
