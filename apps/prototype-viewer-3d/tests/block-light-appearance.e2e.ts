import { expect, test } from "@playwright/test";
import type { sampleBlockLightAppearance } from "../src/lib/testing/block-light-appearance";

test("maximum block light retains terrain colors and contact occlusion", async ({ page }, info) => {
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/appearance-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"></body></html>',
    }),
  );
  await page.goto("/appearance-regression");
  const result: Awaited<ReturnType<typeof sampleBlockLightAppearance>> = await page.evaluate(
    async () => {
      const modulePath = "/src/lib/testing/block-light-appearance.ts";
      return (await import(modulePath)).sampleBlockLightAppearance();
    },
  );
  if (info.project.name === "webgl") expect(result.backend).toBe("WebGL 2");
  expect(errors).toEqual([]);
  for (const { swatches } of result.rows) {
    for (const { occlusion } of swatches) {
      // Even white terrain stays below display clipping at the maximum local level.
      for (const pixel of occlusion) expect(Math.max(...pixel)).toBeLessThan(250);
      const sum = (pixel: number[]) => pixel.reduce((a, b) => a + b, 0);
      const values = occlusion.map(sum);
      expect(values[0]).toBeLessThan(values[3] * 0.98);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    }
    const [wood, stone, red, green, blue] = swatches.map((s) => s.occlusion[3]);
    expect(wood[0]).toBeGreaterThan(stone[0]);
    expect(red[0]).toBeGreaterThan(red[1] * 1.5);
    expect(green[1]).toBeGreaterThan(green[0]);
    expect(blue[2]).toBeGreaterThan(blue[0] * 1.4);
  }
  await info.attach("appearance-pixels", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});
