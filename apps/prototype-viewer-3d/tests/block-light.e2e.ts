import { expect, test } from "@playwright/test";

test("block light brightens neighboring faces with and without textures", async ({
  page,
  request,
}, info) => {
  test.skip(Boolean(process.env.MAPELIX_E2E_WORLD_DIRECTORY), "Uses the generated lantern catalog");
  if (info.project.name === "webgl")
    await page.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/lighting-regression", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0"><div id="viewer" style="width:800px;height:600px"></div></body></html>',
    }),
  );
  const world = await (await request.get("/world.json")).json();
  await page.goto("/lighting-regression");
  for (const textures of ["off", "on"]) {
    await page.evaluate(
      async ({ world, textures }) => {
        const modulePath = "/src/lib/world-viewer.ts";
        const { WorldViewer } = await import(modulePath);
        const old = Reflect.get(window, "__lightingViewer");
        old?.dispose();
        const viewer = await WorldViewer.create(
          document.getElementById("viewer"),
          world,
          { x: 35, y: 79, z: 46, distance: 24, heading: 0, pitch: 1.53 },
          { hour: 0, clouds: false, weather: "clear", textures, textureFade: { none: 1, full: 2 } },
        );
        viewer.setRenderDistance(128);
        Reflect.set(window, "__lightingViewer", viewer);
      },
      { world, textures },
    );
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const snapshot = Reflect.get(window, "__lightingViewer").snapshot();
            return (
              snapshot.streaming.quads > 0 &&
              !snapshot.streaming.remaining &&
              !snapshot.streaming.loading &&
              snapshot.textures.state !== "loading"
            );
          }),
        { timeout: 45000 },
      )
      .toBe(true);
    await page.waitForTimeout(1200);
    const backend = await page.evaluate(
      () => Reflect.get(window, "__lightingViewer").snapshot().backend,
    );
    if (info.project.name === "webgl") expect(backend).toBe("WebGL 2");
    else expect(["WebGPU", "WebGL 2"]).toContain(backend);
    await page.evaluate(() =>
      Reflect.get(Reflect.get(window, "__lightingViewer"), "renderer").setAnimationLoop(null),
    );
    await page.waitForTimeout(100);
    const render = () =>
      page.evaluate(() => {
        const viewer = Reflect.get(window, "__lightingViewer");
        const renderer = Reflect.get(viewer, "renderer");
        renderer._nodes.nodeFrame.lastTime = performance.now();
        renderer._nodes.nodeFrame.time = 7.25;
        Reflect.get(viewer, "pipeline").render();
      });
    await render();
    await page.waitForTimeout(100);
    const clip = { x: 330, y: 230, width: 140, height: 140 };
    const lit = await page.screenshot({ clip, path: info.outputPath(`${textures}-lit.png`) });
    const changed = await page.evaluate(() => {
      const viewer = Reflect.get(window, "__lightingViewer");
      const drawn = Reflect.get(Reflect.get(viewer, "streamer"), "drawn") as Map<
        string,
        { group: { traverse(fn: (object: unknown) => void): void } }
      >;
      let changed = 0;
      for (const mesh of drawn.values())
        mesh.group.traverse((object) => {
          const geometry = Reflect.get(object as object, "geometry");
          const attribute = geometry?.getAttribute("texture");
          if (!attribute) return;
          for (let i = 0; i < attribute.array.length; i++) {
            if ((attribute.array[i] >>> 27) & 15) changed++;
            attribute.array[i] &= ~0x78000000;
          }
          attribute.needsUpdate = true;
        });
      return changed;
    });
    expect(changed).toBeGreaterThan(0);
    await render();
    await page.waitForTimeout(100);
    const dark = await page.screenshot({ clip, path: info.outputPath(`${textures}-dark.png`) });
    const difference = await page.evaluate(
      async ([lit, dark]) => {
        async function pixels(base64: string) {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = new OffscreenCanvas(image.width, image.height);
          const context = canvas.getContext("2d")!;
          context.drawImage(image, 0, 0);
          return context.getImageData(0, 0, image.width, image.height).data;
        }
        const a = await pixels(lit!),
          b = await pixels(dark!);
        let red = 0,
          changed = 0;
        for (let i = 0; i < a.length; i += 4) {
          red += a[i]! - b[i]!;
          if (
            Math.abs(a[i]! - b[i]!) +
              Math.abs(a[i + 1]! - b[i + 1]!) +
              Math.abs(a[i + 2]! - b[i + 2]!) >
            12
          )
            changed++;
        }
        return { meanRedGain: red / (a.length / 4), changedPixels: changed };
      },
      [lit.toString("base64"), dark.toString("base64")],
    );
    await info.attach(`${textures}-${backend}-lit`, { body: lit, contentType: "image/png" });
    await info.attach(`${textures}-metrics`, {
      body: JSON.stringify(difference),
      contentType: "application/json",
    });
    expect(difference.meanRedGain).toBeGreaterThan(3);
    expect(difference.changedPixels).toBeGreaterThan(1000);
  }
  await page.evaluate(() => Reflect.get(window, "__lightingViewer").dispose());
  expect(errors).toEqual([]);
});
