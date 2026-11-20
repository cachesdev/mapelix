import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  createWriteStream,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { empty } from "./prototype.mjs";
import { encodeSceneRegion } from "../../packages/mapelix-scene-prototype/dist/format.js";
const root = resolve(import.meta.dirname, "../.."),
  out = join(root, ".local/underground-m0/results"),
  app = join(root, "apps/prototype-viewer-3d");
const { views, assets } = JSON.parse(
  readFileSync(join(out, "views.json"), "utf8"),
);
const payloads = new Map(
  assets.map((a) => [a.file, readFileSync(join(out, "payloads", a.file))]),
);
const browserCode = readFileSync(
  new URL("./browser-loop.mjs", import.meta.url),
  "utf8",
);
const patchStart = browserCode.search(/^\s+if\s*\(cleanupFix\)\s*\{/m);
const patchEnd = browserCode.indexOf("const { WorldViewer }", patchStart);
const patch = browserCode.slice(patchStart, patchEnd);
if (!patch.includes("originalDispose"))
  throw new Error("Missing tested pool patch");
mkdirSync(join(root, ".local/tmp"), { recursive: true });
const viteLog = createWriteStream(join(out, "direct-server.log"));
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "dev",
    "--config",
    join(app, ".local/underground-m0-vite.config.mjs"),
    "--host",
    "127.0.0.1",
    "--port",
    "5199",
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
vite.stdout.pipe(viteLog);
vite.stderr.pipe(viteLog);
const proxy = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:5200");
  if (url.pathname === "/m0") {
    res.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    res.end(
      '<html><body style="margin:0"><div id="viewer" style="width:960px;height:640px"></div></body></html>',
    );
    return;
  }
  const m = /^\/regions\/(\d)\/(-?\d+)\/(-?\d+)/.exec(url.pathname);
  if (m) {
    const named = views.find(
      (v) =>
        v.dimension === url.searchParams.get("dimension") &&
        v.ceilingY === Number(url.searchParams.get("ceilingY")),
    );
    const [level, x, z] = m.slice(1).map(Number),
      file = `${named?.name}-${level}-${x}-${z}.bin`;
    const bytes =
      payloads.get(file) ?? encodeSceneRegion(empty({ level, x, z }));
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(bytes);
    return;
  }
  const up = httpRequest(
    { hostname: "127.0.0.1", port: 5199, path: req.url, method: req.method },
    (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    },
  );
  up.on("error", () => {
    res.statusCode = 502;
    res.end();
  });
  req.pipe(up);
});
function chromeMemory(pid) {
  const code = `$m0All=Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'"; $m0Ids=@(${pid}); do {$m0Next=@($m0All | Where-Object {($_.ParentProcessId -in $m0Ids) -and ($_.ProcessId -notin $m0Ids)} | ForEach-Object {$_.ProcessId}); $m0Ids+=$m0Next} while($m0Next.Count -gt 0); $m0Read=@(Get-Process -Id $m0Ids -ErrorAction SilentlyContinue); [pscustomobject]@{processes=$m0Read.Count;workingSetBytes=($m0Read|Measure-Object WorkingSet64 -Sum).Sum;privateBytes=($m0Read|Measure-Object PrivateMemorySize64 -Sum).Sum}|ConvertTo-Json -Compress`;
  return JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-Command", code], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 20000,
    }),
  );
}
const results = [];
try {
  await new Promise((r) => proxy.listen(5200, "127.0.0.1", r));
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch("http://127.0.0.1:5199")).status < 500) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw new Error("Vite not ready");
  for (const backend of ["auto", "webgl"]) {
    const profile = join(out, "chrome-profiles", randomUUID());
    mkdirSync(profile, { recursive: true });
    const chrome = spawn(
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      [
        "--headless=new",
        "--remote-debugging-port=0",
        "--remote-allow-origins=*",
        "--user-data-dir=" + profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-extensions",
        "--enable-unsafe-swiftshader",
        "--js-flags=--expose-gc",
        "--window-size=960,640",
        "about:blank",
      ],
      { windowsHide: true, stdio: "ignore" },
    );
    let ws;
    try {
      let port;
      for (let i = 0; i < 120; i++) {
        try {
          port = Number(
            readFileSync(join(profile, "DevToolsActivePort"), "utf8").split(
              "\n",
            )[0],
          );
          break;
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!port) throw new Error("Chrome not ready");
      const targets = await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json(),
        target = targets.find((t) => t.type === "page");
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((r, j) => {
        ws.addEventListener("open", r, { once: true });
        ws.addEventListener("error", j, { once: true });
      });
      let id = 0;
      const pending = new Map(),
        samples = [],
        errors = [];
      const send = (method, params = {}) =>
        new Promise((resolve, reject) => {
          const n = ++id;
          pending.set(n, { resolve, reject });
          ws.send(JSON.stringify({ id: n, method, params }));
        });
      ws.addEventListener("message", async (e) => {
        const m = JSON.parse(e.data);
        if (m.id) {
          const p = pending.get(m.id);
          pending.delete(m.id);
          if (m.error) p.reject(new Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
          return;
        }
        if (m.method === "Runtime.exceptionThrown")
          errors.push(m.params.exceptionDetails.text);
        if (
          m.method === "Runtime.consoleAPICalled" &&
          m.params.type === "error"
        )
          errors.push(
            m.params.args.map((a) => a.value ?? a.description).join(" "),
          );
        if (
          m.method === "Runtime.bindingCalled" &&
          m.params.name === "__m0Checkpoint"
        ) {
          const sample = JSON.parse(m.params.payload);
          await send("HeapProfiler.collectGarbage");
          sample.heap = await send("Runtime.getHeapUsage");
          sample.chrome = chromeMemory(chrome.pid);
          samples.push(sample);
          writeFileSync(
            join(out, `lifecycle-direct-${backend}.json`),
            JSON.stringify(
              {
                backend,
                method:
                  "Direct CDP; Network domain never enabled; bounded pool and retained water depth; precomputed real-world regions and generated End",
                samples,
                errors,
              },
              null,
              2,
            ),
          );
          console.log(
            JSON.stringify({
              backend,
              n: sample.index + 1,
              heapMiB: sample.heap.usedSize / 1048576,
              uniforms: sample.memory.uniformBuffers,
              textures: sample.memory.textures,
              chrome: sample.chrome,
            }),
          );
          await send("Runtime.evaluate", { expression: "window.__m0Resume()" });
        }
      });
      await send("Runtime.enable");
      await send("Page.enable");
      await send("Runtime.addBinding", { name: "__m0Checkpoint" });
      await send("Page.navigate", { url: "http://127.0.0.1:5200/m0" });
      for (let i = 0; i < 100; i++) {
        const r = await send("Runtime.evaluate", {
          expression: 'Boolean(document.getElementById("viewer"))',
          returnByValue: true,
        });
        if (r.result.value) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const expression = `(async()=>{
    ${backend === "webgl" ? 'Object.defineProperty(navigator,"gpu",{value:undefined});' : ""}
    const cleanupFix=true,meshPool=true;
    ${patch}
    const {WorldViewer}=await import('/src/lib/viewer/world-viewer.ts');
    const views=${JSON.stringify(views)},pause=ms=>new Promise(r=>setTimeout(r,ms)),info=views[0];
    window.__viewer=await WorldViewer.create(document.getElementById('viewer'),{...info,revision:'m0',name:'Milestone 0'},{...info.spawn,distance:85,pitch:.8,heading:.4});
    window.__viewer.setRenderDistance(96);window.__viewer.rig.settling=false;
    for(let index=0;index<104;index++){
     const v=window.__viewer,info=views[index%4];v.setWorld({...info,revision:'m0',name:'Milestone 0'},false);v.rig.setView({...info.spawn,distance:85,pitch:.8,heading:.4},{settle:false});v.setRenderDistance(96);
     const start=performance.now();while(v.snapshot().streaming.loading||!v.snapshot().streaming.quads){if(performance.now()-start>20000)throw new Error('Region timeout');await pause(20);}await pause(550);
     if(index%4===3){await new Promise(resolve=>{window.__m0Resume=resolve;window.__m0Checkpoint(JSON.stringify({index,backend:v.backend,memory:{...v.renderer.info.memory},streaming:v.snapshot().streaming,pool:[...window.__m0Pools.values()].reduce((n,p)=>n+p.length,0)}));});}
    }
    window.__viewer.dispose();window.__viewer=null;for(const p of window.__m0Pools.values())for(const m of p)m.dispose();window.__m0Pools.clear();return {canvases:document.querySelectorAll('canvas').length};
   })()`;
      const end = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (end.exceptionDetails)
        throw new Error(JSON.stringify(end.exceptionDetails));
      await send("HeapProfiler.collectGarbage");
      const disposedHeap = await send("Runtime.getHeapUsage");
      const result = {
        backend,
        switches: 104,
        method:
          "Direct CDP; Network domain never enabled; no Playwright transport instrumentation",
        samples,
        errors,
        disposed: end.result.value,
        disposedHeap,
      };
      results.push(result);
      writeFileSync(
        join(out, `lifecycle-direct-${backend}.json`),
        JSON.stringify(result, null, 2),
      );
      if (errors.length) throw new Error(errors.slice(0, 2).join("\n"));
    } finally {
      ws?.close();
      chrome.kill();
    }
  }
  writeFileSync(
    join(out, "lifecycle-direct.json"),
    JSON.stringify(results, null, 2),
  );
} finally {
  proxy.close();
  vite.kill();
  viteLog.end();
}
