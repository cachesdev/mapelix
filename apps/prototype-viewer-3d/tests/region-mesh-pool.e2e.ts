import { expect, test } from "@playwright/test";

test("pooled meshes keep valid GPU buffers across lit and unlit layouts", async ({
  page,
}, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/pool-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"></body></html>',
    }),
  );
  await page.goto("/pool-regression");
  const result = await page.evaluate(async () => {
    const modulePath = "/src/lib/testing/region-mesh-pool.ts";
    return (await import(modulePath)).renderPooledRegions();
  });
  if (info.project.name === "webgl") expect(result.backend).toBe("WebGL 2");
  expect(errors).toEqual([]);
  expect(result.red[0]).toBeGreaterThan(result.red[1] + 20);
  expect(result.red[2]).toBe(result.red[0]);
  expect(result.red[3]).toBe(result.red[1]);
});
