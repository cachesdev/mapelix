import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openBedrockWorld, writeLeafletTile } from "@mapelix/prototype";

const run = promisify(execFile);
const fixture = fileURLToPath(
  new URL("../../../packages/mapelix-prototype/test/fixtures/2000world.mcworld", import.meta.url),
);
const tileRoot = fileURLToPath(new URL("../../../generated-tiles", import.meta.url));
const tileUrl = "/tiles/0/-1/0.png";

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Mapelix visual check</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; background: #111512; color: #edf3ed; }
      main { width: min-content; margin: 32px auto; }
      p { color: #a8b5aa; }
      #tile-frame { width: 256px; height: 256px; background: #1b211d; box-shadow: 0 0 0 1px #3b473e; }
      img { display: block; width: 256px; height: 256px; image-rendering: pixelated; }
    </style>
  </head>
  <body>
    <main>
      <h1>Mapelix prototype tile</h1>
      <p>Overworld · z0 · x−1 · y0</p>
      <div id="tile-frame"><img src="${tileUrl}" alt="Generated Minecraft map tile"></div>
    </main>
  </body>
</html>`;

const tilePath = await prepareTile();

createServer(async (request, response) => {
  if (request.url === tileUrl) {
    response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
    response.end(await readFile(tilePath));
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}).listen(4173, "127.0.0.1", () => {
  console.log("Visual check listening on http://127.0.0.1:4173");
});

async function prepareTile(): Promise<string> {
  const worldDirectory = await mkdtemp(join(tmpdir(), "mapelix-visual-"));
  try {
    await run("unzip", ["-qq", fixture, "-d", worldDirectory]);
    const world = await openBedrockWorld({ directory: worldDirectory });
    const tile = await world.renderTile({ dimension: "overworld", z: 0, x: -1, y: 0 });
    return await writeLeafletTile(tile, { root: tileRoot });
  } finally {
    await rm(worldDirectory, { recursive: true, force: true });
  }
}
