import { expect, test } from "@playwright/test";

test("lava keeps its texture and animation in every coordinate quadrant", async ({
  page,
}, testInfo) => {
  test.skip(Boolean(process.env.MAPELIX_E2E_WORLD_DIRECTORY), "Uses the generated lava pools");
  test.setTimeout(180_000);
  if (testInfo.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  for (const dimension of ["overworld", "nether", "the-end"])
    for (const [x, z] of [
      [46, 16],
      [-48, 16],
      [48, -48],
      [-48, -48],
    ]) {
      await page.goto(
        `/?dimension=${dimension}&x=${x}&y=79.875&z=${z}&distance=20&heading=0&pitch=80`,
      );
      await expect(page.getByText("All nearby terrain loaded")).toBeVisible({ timeout: 45_000 });
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);
      await page.keyboard.press("F3");
      const backend = await page
        .locator("dt")
        .filter({ hasText: /^Renderer$/ })
        .locator("+ dd")
        .textContent();
      expect(["WebGPU", "WebGL 2"]).toContain(backend);
      if (testInfo.project.name === "webgl") expect(backend).toBe("WebGL 2");
      testInfo.annotations.push({ type: "renderer", description: backend ?? "unknown" });
      const canvas = await page.locator("canvas").boundingBox();
      const clip = {
        x: canvas!.x + canvas!.width / 2 - 48,
        y: canvas!.y + canvas!.height / 2 - 48,
        width: 96,
        height: 96,
      };
      const first = await page.screenshot({ clip });
      await page.waitForTimeout(1200);
      const second = await page.screenshot({ clip });
      // Read actual pixels: PNG byte differences alone can miss a flat, non-animated pool.
      const stats = await page.evaluate(
        async ([a, b]) => {
          async function pixels(base64: string) {
            const image = new Image();
            image.src = `data:image/png;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement("canvas");
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext("2d")!;
            context.drawImage(image, 0, 0);
            return context.getImageData(0, 0, image.width, image.height).data;
          }
          const first = await pixels(a!);
          const second = await pixels(b!);
          let sum = 0;
          let squares = 0;
          let motion = 0;
          const count = first.length / 4;
          for (let i = 0; i < first.length; i += 4) {
            const light = (first[i]! + first[i + 1]! + first[i + 2]!) / 3;
            const next = (second[i]! + second[i + 1]! + second[i + 2]!) / 3;
            sum += light;
            squares += light * light;
            motion += Math.abs(light - next);
          }
          return {
            contrast: Math.sqrt(squares / count - (sum / count) ** 2),
            motion: motion / count,
          };
        },
        [first.toString("base64"), second.toString("base64")],
      );
      const label = `${testInfo.project.name} ${dimension} (${x}, ${z})`;
      await testInfo.attach(label, { body: second, contentType: "image/png" });
      await testInfo.attach(`${label} metrics`, {
        body: JSON.stringify(stats),
        contentType: "application/json",
      });
      if (x === -48 && z === -48)
        await page.screenshot({
          path: `test-results/${testInfo.project.name}-${dimension}-negative-lava.png`,
        });
      expect(stats.contrast, `${label}: spatial texture`).toBeGreaterThan(8);
      expect(stats.motion, `${label}: animated surface`).toBeGreaterThan(1);
    }
  expect(errors).toEqual([]);
});
