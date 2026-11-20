import { expect, test } from "@playwright/test";

test("cave HTTP contexts normalize negative aliases and reject unsupported slices and LODs", async ({
  request,
}) => {
  const canonical = "/regions/0/0/0?mode=caves&minY=-64&maxY=-32";
  const first = await request.get(canonical);
  expect(first.ok()).toBe(true);
  const alias = await request.get("/regions/0/0/0?mode=caves&minY=-64&ceilingY=-32");
  expect(alias.headers()["x-mapelix-cache"]).toBe("memory");
  expect(await alias.body()).toEqual(await first.body());
  const surface = await request.get("/regions/0/0/0?ceilingY=-32");
  expect((await surface.body()).equals(await first.body())).toBe(false);
  const metadata = await (await request.get("/world.json?mode=caves")).json();
  expect(metadata).toMatchObject({
    mode: "caves",
    minY: -64,
    maxY: -32,
    ceilingY: -32,
    caves: { thicknesses: [16, 32], defaultThickness: 32, maxLevel: 1, viewDistance: 128 },
  });
  for (const query of [
    "mode=invalid",
    "mode=caves&minY=-64&maxY=0",
    "mode=caves&minY=-65&maxY=-33",
    "mode=caves&minY=-64&maxY=-32&ceilingY=-16",
    "mode=surface&minY=-32&maxY=0",
  ]) {
    expect((await request.get(`/world.json?${query}`)).status()).toBe(400);
    expect((await request.get(`/regions/0/0/0?${query}`)).status()).toBe(400);
  }
  expect((await request.get("/regions/2/0/0?mode=caves")).status()).toBe(400);
});

test("the local viewer exposes cave depth/thickness, updates on release and retains one canvas", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/?dimension=overworld&x=16&y=80&z=16&distance=80");
  const mode = page.getByLabel("View", { exact: true });
  await expect(mode).toBeEnabled({ timeout: 30_000 });
  const canvas = await page.locator("canvas").elementHandle();
  await mode.selectOption("caves");
  await expect(page.getByLabel("Slice thickness")).toHaveValue("32");
  await expect.poll(() => new URL(page.url()).searchParams.get("mode")).toBe("caves");
  await expect.poll(() => Number(new URL(page.url()).searchParams.get("y"))).toBeLessThan(0);
  await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 30_000 });
  expect(await canvas!.evaluate((node) => node === document.querySelector("canvas"))).toBe(true);
  await page.waitForTimeout(700); // Capture after the existing terrain dissolve completes.
  await page.screenshot({ path: `test-results/${testInfo.project.name}-caves.png` });
  await page.setViewportSize({ width: 900, height: 600 });
  await expect
    .poll(() => page.locator("canvas").evaluate((canvas) => canvas.clientWidth))
    .toBe(900);
  await page.setViewportSize({ width: 1200, height: 800 });
  let metadataRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/world.json")) metadataRequests++;
  });
  const depth = page.locator("#cave-min-y");
  await depth.evaluate((element: HTMLInputElement) => {
    element.value = "-48";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  expect(metadataRequests).toBe(0);
  await depth.dispatchEvent("change");
  await expect(mode).toBeEnabled();
  await expect.poll(() => new URL(page.url()).searchParams.get("minY")).toBe("-48");
  await page.getByLabel("Slice thickness").selectOption("16");
  await expect.poll(() => new URL(page.url()).searchParams.get("maxY")).toBe("-32");
  await page.reload();
  await expect(mode).toBeEnabled({ timeout: 30_000 });
  await expect(mode).toHaveValue("caves");
  await expect(page.getByLabel("Slice thickness")).toHaveValue("16");
  const reloadedCanvas = await page.locator("canvas").elementHandle();
  await mode.selectOption("surface");
  await expect(mode).toBeEnabled();
  expect(await reloadedCanvas!.evaluate((node) => node === document.querySelector("canvas"))).toBe(
    true,
  );
  await expect(page.locator("canvas")).toHaveCount(1);
  expect(canvas).not.toBeNull();
  expect(errors).toEqual([]);
});
