import { expect, test } from "@playwright/test";

test("the HTTP adapter isolates dimensions and ceiling caches", async ({ request }) => {
  const bytes: Buffer[] = [];
  for (const dimension of ["overworld", "nether", "the-end"]) {
    const metadata = await request.get(`/world.json?dimension=${dimension}`);
    expect(metadata.ok()).toBe(true);
    const info = await metadata.json();
    expect(info.dimension).toBe(dimension);
    expect(info.dimensions).toHaveLength(3);
    const url = `/regions/0/0/0?dimension=${dimension}&revision=${info.revision}`;
    const first = await request.get(url);
    expect(first.ok()).toBe(true);
    bytes.push(await first.body());
    const second = await request.get(url);
    expect(second.headers()["x-mapelix-cache"]).toBe("memory");
    expect(await second.body()).toEqual(bytes.at(-1));
  }
  expect(bytes[0]!.equals(bytes[1]!)).toBe(false);
  expect(bytes[1]!.equals(bytes[2]!)).toBe(false);
  const cut = await request.get("/regions/0/0/0?dimension=nether&ceilingY=128");
  expect(cut.ok()).toBe(true);
  expect((await cut.body()).equals(bytes[1]!)).toBe(false);
  for (const query of ["dimension=moon", "dimension=nether&ceilingY=129", "dimension=__proto__"]) {
    expect((await request.get(`/world.json?${query}`)).status()).toBe(400);
    expect((await request.get(`/regions/0/0/0?${query}`)).status()).toBe(400);
  }
  expect((await request.get("/regions/0/0/0?revision=stale")).status()).toBe(409);
});

test("the viewer switches dimensions, shares the selection and retains its canvas", async ({
  page,
}, testInfo) => {
  if (testInfo.project.name === "webgl") {
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  }
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/?dimension=overworld&x=32&y=80&z=32&distance=100");
  const selector = page.getByLabel("Dimension", { exact: true });
  await expect(selector).toBeEnabled({ timeout: 30_000 });
  const canvas = await page.locator("canvas").elementHandle();
  expect(canvas).not.toBeNull();
  for (const dimension of ["nether", "the-end", "overworld"]) {
    const loaded = page.waitForResponse(
      (response) =>
        response.url().includes("/regions/") &&
        response.url().includes(`dimension=${dimension}`) &&
        response.ok(),
    );
    await selector.selectOption(dimension);
    await expect(selector).toBeEnabled();
    await expect.poll(() => new URL(page.url()).searchParams.get("dimension")).toBe(dimension);
    await loaded;
    await page.waitForLoadState("networkidle", { timeout: 30_000 });
    await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(500); // Finish the existing region dissolve before capturing.
    expect(await canvas!.evaluate((node) => node === document.querySelector("canvas"))).toBe(true);
    await expect(page.locator("canvas")).toHaveCount(1);
    await page.screenshot({ path: `test-results/${testInfo.project.name}-${dimension}.png` });
  }
  await selector.selectOption("nether");
  await expect(selector).toBeEnabled();
  await page.locator("#ceiling").fill("80");
  await page.locator("#ceiling").dispatchEvent("change");
  await expect.poll(() => new URL(page.url()).searchParams.get("ceilingY")).toBe("80");
  await page.reload();
  await expect(selector).toBeEnabled({ timeout: 30_000 });
  await expect(selector).toHaveValue("nether");
  await expect(page.locator("#ceiling")).toHaveValue("80");
  await page.keyboard.press("F3");
  const backend = await page
    .locator("dt")
    .filter({ hasText: /^Renderer$/ })
    .locator("+ dd")
    .textContent();
  testInfo.annotations.push({ type: "renderer", description: backend ?? "unknown" });
  if (testInfo.project.name === "webgl") expect(backend).toBe("WebGL 2");
  expect(errors).toEqual([]);
});
