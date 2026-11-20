import { createRequire } from "node:module";
import {
  readFileSync,
  writeFileSync,
  createWriteStream,
  mkdirSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { empty } from "./prototype.mjs";
import { encodeSceneRegion } from "../../packages/mapelix-scene-prototype/dist/format.js";
const root = resolve(import.meta.dirname, "../.."),
  app = join(root, "apps/prototype-viewer-3d"),
  out = join(root, ".local/underground-m0/results");
const require = createRequire(join(app, "package.json"));
const playwright = await import(
  pathToFileURL(require.resolve("@playwright/test"))
);
const { chromium } = playwright.default ?? playwright;
const { views, assets } = JSON.parse(
  readFileSync(join(out, "views.json"), "utf8"),
);
const payloads = new Map(
  assets.map((a) => [a.file, readFileSync(join(out, "payloads", a.file))]),
);
const port = 5199,
  origin = `http://127.0.0.1:${port}`;
const waterFix = process.env.M0_WATER_FIX === "1";
const config = join(app, ".local/underground-m0-vite.config.mjs");
mkdirSync(join(app, ".local"), { recursive: true });
mkdirSync(join(root, ".local/tmp"), { recursive: true });
writeFileSync(
  config,
  `import original from '../vite.config.ts';
export default {...original,optimizeDeps:{include:['three/webgpu','three/tsl','three/addons/controls/MapControls.js','three/addons/tsl/display/BloomNode.js']},plugins:[{name:'m0-retained-water-depth',enforce:'pre',transform(code,id){
 if(!${waterFix} || !id.replaceAll('\\\\','/').endsWith('/shaders/materials.ts'))return;
 const anchor='function createWaterMaterial(atmosphere: Atmosphere): MeshBasicNodeMaterial {';
 if(!code.includes(anchor)||!code.includes('viewportDepthTexture(uv).x'))throw new Error('M0 water anchor missing');
 return code.replace(anchor,anchor+'\\n  const retainedViewportDepth = viewportDepthTexture();').replaceAll('viewportDepthTexture(uv).x','retainedViewportDepth.sample(uv).x');
}},...original.plugins]};`,
);
const log = createWriteStream(join(out, "browser-server.log"));
const server = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "dev",
    "--config",
    config,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    cwd: app,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TMP: join(root, ".local/tmp"),
      TEMP: join(root, ".local/tmp"),
    },
  },
);
server.stdout.pipe(log);
server.stderr.pipe(log);
const results = [];
const cleanupFix = process.env.M0_CLEANUP_FIX === "1";
const meshPool = process.env.M0_MESH_POOL === "1";
const prefix = meshPool
  ? "lifecycle-pooled"
  : waterFix
    ? "lifecycle-stable"
    : cleanupFix
      ? "lifecycle-fixed"
      : "lifecycle";
function chromeMemory(pid) {
  const code = `$m0All=Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"; $m0Ids=@(${pid}); do {$m0Next=@($m0All | Where-Object {($_.ParentProcessId -in $m0Ids) -and ($_.ProcessId -notin $m0Ids)} | ForEach-Object {$_.ProcessId}); $m0Ids+= $m0Next} while($m0Next.Count -gt 0); $m0Read=@(Get-Process -Id $m0Ids -ErrorAction SilentlyContinue); [pscustomobject]@{processes=$m0Read.Count; workingSetBytes=($m0Read | Measure-Object WorkingSet64 -Sum).Sum; privateBytes=($m0Read | Measure-Object PrivateMemorySize64 -Sum).Sum} | ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", code], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    }),
  );
}
try {
  let ready = false;
  for (let n = 0; n < 120; n++) {
    try {
      const response = await fetch(origin);
      if (response.status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error("M0 browser Vite server not ready");
  for (const backend of (process.env.M0_BACKENDS ?? "auto,webgl").split(",")) {
    const browserServer = await chromium.launchServer({
      channel: "chrome",
      headless: true,
      args: ["--enable-unsafe-swiftshader", "--js-flags=--expose-gc"],
    });
    const browser = await chromium.connect(browserServer.wsEndpoint());
    try {
      const page = await browser.newPage({
        viewport: { width: 960, height: 640 },
      });
      const cdp = await page.context().newCDPSession(page);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      await page.addInitScript(
        ({ forceGL }) => {
          if (forceGL)
            Object.defineProperty(navigator, "gpu", { value: undefined });
          window.__gpu = {
            buffers: 0,
            bufferBytes: 0,
            textures: 0,
            textureBytes: 0,
            createdBuffers: 0,
            destroyedBuffers: 0,
            createdTextures: 0,
            destroyedTextures: 0,
          };
          const counters = window.__gpu;
          if (typeof GPUDevice !== "undefined") {
            const destroyDevice = GPUDevice.prototype.destroy;
            GPUDevice.prototype.destroy = function () {
              counters.releasedWithDevice = {
                buffers: counters.buffers,
                bufferBytes: counters.bufferBytes,
                textures: counters.textures,
                textureBytes: counters.textureBytes,
              };
              counters.buffers = 0;
              counters.bufferBytes = 0;
              counters.textures = 0;
              counters.textureBytes = 0;
              counters.deviceDestroyed = true;
              return destroyDevice.call(this);
            };
            const buffers = new WeakMap(),
              textures = new WeakMap();
            const createBuffer = GPUDevice.prototype.createBuffer,
              destroyBuffer = GPUBuffer.prototype.destroy;
            GPUDevice.prototype.createBuffer = function (d) {
              const b = createBuffer.call(this, d);
              buffers.set(b, d.size);
              counters.buffers++;
              counters.createdBuffers++;
              counters.bufferBytes += d.size;
              return b;
            };
            GPUBuffer.prototype.destroy = function () {
              const size = buffers.get(this);
              if (size !== undefined) {
                buffers.delete(this);
                counters.buffers--;
                counters.destroyedBuffers++;
                counters.bufferBytes -= size;
              }
              return destroyBuffer.call(this);
            };
            const createTexture = GPUDevice.prototype.createTexture,
              destroyTexture = GPUTexture.prototype.destroy;
            GPUDevice.prototype.createTexture = function (d) {
              const t = createTexture.call(this, d);
              const s = d.size;
              const w = Array.isArray(s) ? s[0] : s.width,
                h = (Array.isArray(s) ? s[1] : s.height) || 1,
                z = (Array.isArray(s) ? s[2] : s.depthOrArrayLayers) || 1;
              const bpp = d.format.includes("rgba32")
                ? 16
                : d.format.includes("rgba16")
                  ? 8
                  : d.format.includes("rg32")
                    ? 8
                    : 4;
              const size =
                w *
                h *
                z *
                bpp *
                (d.sampleCount || 1) *
                (d.mipLevelCount > 1 ? 4 / 3 : 1);
              textures.set(t, size);
              counters.textures++;
              counters.createdTextures++;
              counters.textureBytes += size;
              return t;
            };
            GPUTexture.prototype.destroy = function () {
              const size = textures.get(this);
              if (size !== undefined) {
                textures.delete(this);
                counters.textures--;
                counters.destroyedTextures++;
                counters.textureBytes -= size;
              }
              return destroyTexture.call(this);
            };
          }
        },
        { forceGL: backend === "webgl" },
      );
      let current = views[0],
        cacheHits = 0,
        emptyResponses = 0;
      await page.route("**/m0", (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: '<html><body style="margin:0"><div id="viewer" style="width:960px;height:640px"></div></body></html>',
        }),
      );
      await page.route("**/regions/**", async (route) => {
        const url = new URL(route.request().url()),
          m = /\/regions\/(\d)\/(-?\d+)\/(-?\d+)/.exec(url.pathname);
        if (!m) return route.abort();
        const named = views.find(
          (v) =>
            v.dimension === url.searchParams.get("dimension") &&
            v.ceilingY === Number(url.searchParams.get("ceilingY")),
        );
        const [level, x, z] = m.slice(1).map(Number),
          file = `${named?.name}-${level}-${x}-${z}.bin`;
        let bytes = payloads.get(file);
        if (bytes) cacheHits++;
        else {
          bytes = encodeSceneRegion(empty({ level, x, z }));
          emptyResponses++;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from(bytes),
        });
      });
      await page.goto(origin + "/m0");
      await page.evaluate(
        async ({ info, cleanupFix, meshPool }) => {
          if (cleanupFix) {
            const { RegionMesh } =
              await import("/src/lib/viewer/region-mesh.ts");
            const originalDispose = RegionMesh.prototype.dispose;
            if (meshPool) {
              const pools = new Map(),
                add = RegionMesh.prototype.add;
              window.__m0Pools = pools;
              RegionMesh.prototype.add = function (
                quads,
                materials,
                bounds,
                options,
              ) {
                add.call(this, quads, materials, bounds, options);
                if (!quads.length) return;
                const layer = this.layers.at(-1),
                  fresh = layer.mesh,
                  reused = pools.get(materials)?.pop();
                if (reused) {
                  reused.geometry = fresh.geometry;
                  reused.material = fresh.material;
                  reused.castShadow = fresh.castShadow;
                  reused.receiveShadow = fresh.receiveShadow;
                  reused.renderOrder = fresh.renderOrder;
                  reused.userData = fresh.userData;
                  reused.matrix.copy(fresh.matrix);
                  reused.matrixAutoUpdate = false;
                  this.group.remove(fresh);
                  this.group.add(reused);
                  layer.mesh = reused;
                  fresh.dispose();
                }
              };
              RegionMesh.prototype.dispose = function () {
                const layers = [...this.layers];
                originalDispose.call(this);
                for (const { mesh, materials } of layers) {
                  mesh.geometry.getAttribute("quad").array = new Uint32Array(0);
                  let pool = pools.get(materials);
                  if (!pool) pools.set(materials, (pool = []));
                  if (pool.length < 16) pool.push(mesh);
                  else mesh.dispose();
                }
              };
            } else
              RegionMesh.prototype.dispose = function () {
                for (const mesh of this.group.children) mesh.dispose();
                originalDispose.call(this);
              };
          }
          const { WorldViewer } =
            await import("/src/lib/viewer/world-viewer.ts");
          window.__viewer = await WorldViewer.create(
            document.getElementById("viewer"),
            { ...info, revision: "m0-snapshot", name: "Milestone 0" },
            { ...info.spawn, distance: 85, pitch: 0.8, heading: 0.4 },
          );
          window.__viewer.setRenderDistance(96);
          window.__viewer.rig.settling = false;
        },
        { info: current, cleanupFix, meshPool },
      );

      const samples = [];
      await page.exposeBinding("__m0Checkpoint", async (_, sample) => {
        if (sample.index % 4 === 3) {
          await cdp.send("HeapProfiler.collectGarbage");
          sample.heap = await cdp.send("Runtime.getHeapUsage");
          sample.chrome = chromeMemory(browserServer.process().pid);
          if (
            process.env.M0_HEAP_SNAPSHOTS === "1" &&
            (sample.index === 3 || sample.index === 103)
          ) {
            const parts = [];
            const receive = ({ chunk }) => parts.push(chunk);
            cdp.on("HeapProfiler.addHeapSnapshotChunk", receive);
            await cdp.send("HeapProfiler.takeHeapSnapshot", {
              reportProgress: false,
            });
            cdp.off("HeapProfiler.addHeapSnapshotChunk", receive);
            writeFileSync(
              join(out, `heap-${backend}-${sample.index + 1}.heapsnapshot`),
              parts.join(""),
            );
          }
        }
        samples.push(sample);
        if (sample.index % 4 === 3) {
          writeFileSync(
            join(out, `${prefix}-${backend}.json`),
            JSON.stringify(
              {
                backend,
                cleanupFix,
                waterFix,
                switches: sample.index + 1,
                samples,
                errors,
                cacheHits,
                emptyResponses,
              },
              null,
              2,
            ),
          );
          console.log(
            JSON.stringify({
              backend,
              switches: sample.index + 1,
              heapMiB: sample.heap.usedSize / 1048576,
              uniforms: sample.memory.uniformBuffers,
              textures: sample.memory.textures,
              textureBytes: sample.memory.texturesSize,
              chrome: sample.chrome,
            }),
          );
        }
      });
      await page.evaluate(async (views) => {
        const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let index = 0; index < 104; index++) {
          const info = views[index % 4],
            v = window.__viewer;
          v.setWorld(
            { ...info, revision: "m0-snapshot", name: "Milestone 0" },
            false,
          );
          v.rig.setView(
            { ...info.spawn, distance: 85, pitch: 0.8, heading: 0.4 },
            { settle: false },
          );
          v.setRenderDistance(96);
          const start = performance.now();
          while (
            v.snapshot().streaming.loading !== 0 ||
            v.snapshot().streaming.quads === 0
          ) {
            if (performance.now() - start > 20000)
              throw new Error("Lifecycle terrain timeout");
            await pause(20);
          }
          await pause(550);
          await window.__m0Checkpoint({
            index,
            view: info.name,
            backend: v.backend,
            memory: { ...v.renderer.info.memory },
            gpu: { ...window.__gpu },
            streaming: v.snapshot().streaming,
            pool: window.__m0Pools
              ? [...window.__m0Pools.values()].reduce((n, p) => n + p.length, 0)
              : 0,
          });
        }
      }, views);
      if (errors.length)
        throw new Error(
          "Invalid lifecycle run: " + errors.slice(0, 2).join("\n"),
        );
      await page.screenshot({
        path: join(out, `${prefix}-${backend}-end.png`),
      });
      await page.evaluate(() => {
        window.__viewer.dispose();
        window.__viewer = null;
        if (window.__m0Pools) {
          for (const pool of window.__m0Pools.values())
            for (const mesh of pool) mesh.dispose();
          window.__m0Pools.clear();
        }
      });
      await cdp.send("HeapProfiler.collectGarbage");
      await page.waitForTimeout(1000);
      const disposed = await page.evaluate(() => ({
        gpu: window.__gpu,
        canvases: document.querySelectorAll("canvas").length,
      }));
      disposed.heap = await cdp.send("Runtime.getHeapUsage");
      const result = {
        backend,
        cleanupFix,
        switches: samples.length,
        samples,
        disposed,
        errors,
        cacheHits,
        emptyResponses,
      };
      results.push(result);
      writeFileSync(
        join(out, `${prefix}-${backend}.json`),
        JSON.stringify(result, null, 2),
      );
      if (errors.length)
        throw new Error("Browser errors: " + errors.join("\n"));
    } finally {
      await browser.close();
      await browserServer.close();
    }
  }
  writeFileSync(join(out, `${prefix}.json`), JSON.stringify(results, null, 2));
} finally {
  server.kill();
  log.end();
}
