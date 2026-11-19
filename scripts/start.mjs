// One-step start for people who just want to see their world: asks for the world once, builds
// the app when needed, copies the world, updates the 2D map, starts the viewer with textures and
// block lighting, and opens the browser.
//
// Usage: node scripts/start.mjs [--world <folder>] [--data <folder>] [--port <n>]
//          [--refresh <minutes>] [--reconfigure] [--no-open]
// The Windows `start.cmd` and the `start.sh` script next to the repository root run it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { networkInterfaces, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, "mapelix-start.json");
const RENDER = join(ROOT, "apps/render-cli/dist/index.js");
const SERVER = join(ROOT, "apps/mapelix-demo/build/index.js");
const WINDOWS = platform() === "win32";

const say = (text) => console.log(`\n» ${text}`);
function fail(text) {
  console.error(`\n✖ ${text}`);
  process.exit(1);
}

// --- Options -------------------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 24) fail(`Mapelix needs Node.js 24 or newer (found ${process.versions.node}).
  Download it from https://nodejs.org, install it, then start again.`);

function isWorld(folder) {
  return existsSync(join(folder, "db")) && existsSync(join(folder, "level.dat"));
}

async function configure() {
  let saved = {};
  if (existsSync(CONFIG) && !flag("reconfigure")) {
    try {
      saved = JSON.parse(readFileSync(CONFIG, "utf8"));
    } catch {
      saved = {};
    }
  }
  const config = {
    world: option("world") ?? saved.world,
    data: option("data") ?? saved.data ?? join(ROOT, "mapelix-data"),
    port: Number(option("port") ?? saved.port ?? 3000),
    refresh: Number(option("refresh") ?? saved.refresh ?? 0),
  };
  if (config.world === undefined || !isWorld(config.world)) {
    if (!process.stdin.isTTY) {
      fail(`No Bedrock world at "${config.world ?? ""}": the folder needs "db" and "level.dat".
  Pass another one with --world <folder>.`);
    }
    const ask = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`
Welcome to Mapelix. Point it at a Bedrock world folder: the one that holds "db" and
"level.dat" (for example a world from a server's "worlds" folder, or from the game's
"minecraftWorlds" folder). Mapelix only reads it and works on its own copy.`);
    for (;;) {
      const answer = (await ask.question("\nWorld folder: ")).trim().replace(/^["']|["']$/g, "");
      if (answer !== "" && isWorld(answer)) {
        config.world = resolve(answer);
        break;
      }
      console.log('  This folder has no "db" and "level.dat". Try again.');
    }
    const minutes = (
      await ask.question("Update the map every how many minutes while it runs? (0 = only at start) ")
    ).trim();
    config.refresh = /^\d+$/.test(minutes) ? Number(minutes) : 0;
    ask.close();
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
    fail("--port needs a number between 1 and 65535.");
  if (!Number.isInteger(config.refresh) || config.refresh < 0)
    fail("--refresh needs a whole number of minutes.");
  await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

// --- Build ---------------------------------------------------------------------------------

/**
 * Runs a tool found on the PATH. Windows starts `.cmd` tools (pnpm, npx) through its shell, from
 * one command line; the arguments here never hold spaces.
 */
function tool(command, commandArgs, options) {
  return WINDOWS
    ? spawnSync([command, ...commandArgs].join(" "), { cwd: ROOT, shell: true, ...options })
    : spawnSync(command, commandArgs, { cwd: ROOT, ...options });
}

function run(command, commandArgs) {
  return tool(command, commandArgs, { stdio: "inherit" }).status === 0;
}

function quiet(command, commandArgs) {
  const result = tool(command, commandArgs, { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** pnpm as installed, through Corepack, or downloaded once by npx, in that order. */
function pnpm() {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager;
  if (quiet("pnpm", ["--version"]) !== undefined) return ["pnpm"];
  if (quiet("corepack", ["pnpm", "--version"]) !== undefined) return ["corepack", "pnpm"];
  return ["npx", "--yes", version ?? "pnpm"];
}

async function build(data) {
  const stampFile = join(data, "build-stamp.txt");
  const head = quiet("git", ["rev-parse", "HEAD"]);
  const stamp = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : undefined;
  const built = existsSync(RENDER) && existsSync(SERVER);
  if (built && (head === undefined || head === stamp)) return;
  say(built ? "The code changed: building Mapelix again…" : "First start: installing and building Mapelix (a few minutes)…");
  const [command, ...prefix] = pnpm();
  if (!run(command, [...prefix, "install", "--frozen-lockfile"])) fail("Installing failed.");
  if (
    !run(command, [
      ...prefix,
      "exec",
      "turbo",
      "run",
      "build",
      "--filter=@mapelix/render-cli...",
      "--filter=@mapelix/demo...",
    ])
  )
    fail("Building failed.");
  if (head !== undefined) await writeFile(stampFile, `${head}\n`);
}

// --- World copy and 2D map -----------------------------------------------------------------

/**
 * Each world keeps its copy, map and caches in its own folder, named after the world folder and
 * a short hash of its full path, so switching worlds never mixes two maps and coming back to a
 * world reuses its map. Texture packs are shared by all worlds.
 */
function worldData(config) {
  const name = basename(config.world).replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "world";
  const hash = createHash("sha256").update(resolve(config.world)).digest("hex").slice(0, 8);
  return join(config.data, "worlds", `${name}-${hash}`);
}

/** Mirrors the world into `target`, copying only files whose size or date changed. */
async function mirror(source, target) {
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (!names.has(entry.name)) await rm(join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await mirror(from, to);
      continue;
    }
    if (!entry.isFile()) continue;
    const [a, b] = await Promise.all([stat(from), stat(to).catch(() => undefined)]);
    if (b !== undefined && a.size === b.size && a.mtimeMs <= b.mtimeMs) continue;
    await copyFile(from, to);
  }
}

async function update(config) {
  const snapshot = join(worldData(config), "world");
  const map = join(worldData(config), "map");
  say(`Copying the world "${basename(config.world)}"…`);
  await mirror(config.world, snapshot);
  say("Updating the 2D map (only what changed)…");
  const again = existsSync(join(map, "manifest.json"));
  const ok = spawnSync(process.execPath, [
    RENDER,
    "--world",
    snapshot,
    "--output",
    map,
    "--dimension",
    "overworld,nether,end",
    ...(again ? ["--incremental", "--surface-cache"] : []),
    "--max-tiles",
    "200000",
    "--max-output-bytes",
    String(8 * 1024 ** 3),
    "--timeout-seconds",
    "7200",
    "--memory-budget-mib",
    "4096",
  ], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] }).status === 0;
  if (!ok) fail("The 2D map could not be drawn. Check that the world folder is a Bedrock world.");
}

// --- Server --------------------------------------------------------------------------------

function startServer(config) {
  return spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    stdio: ["ignore", "ignore", "inherit"],
    env: {
      ...process.env,
      PORT: String(config.port),
      MAPELIX_WORLD_DIRECTORY: join(worldData(config), "world"),
      MAPELIX_TILES_DIRECTORY: join(worldData(config), "map"),
      MAPELIX_CACHE_DIRECTORY: join(worldData(config), "cache"),
      MAPELIX_TEXTURE_PACK_DIRECTORY: join(config.data, "texture-packs"),
      MAPELIX_TEXTURE_UPLOADS: "1",
      MAPELIX_TEXTURE_VANILLA: "1",
      BODY_SIZE_LIMIT: "256M",
    },
  });
}

function ready(port) {
  return new Promise((done) => {
    const probe = request({ host: "127.0.0.1", port, path: "/", method: "HEAD" }, (response) => {
      response.resume();
      done(true);
    });
    probe.on("error", () => done(false));
    probe.end();
  });
}

async function waitFor(port) {
  for (let i = 0; i < 120; i++) {
    if (await ready(port)) return;
    await new Promise((wake) => setTimeout(wake, 500));
  }
  fail(`The viewer did not start on port ${port}. Is another program using it? Try --port 3001.`);
}

function open(url) {
  const command = WINDOWS ? "cmd" : platform() === "darwin" ? "open" : "xdg-open";
  const commandArgs = WINDOWS ? ["/c", "start", "", url] : [url];
  spawn(command, commandArgs, { stdio: "ignore", detached: true }).unref();
}

/** Opens on the world spawn, close enough to see blocks, with textures on. */
async function startView(config) {
  const view = new URLSearchParams({ textures: "1" });
  try {
    const { readLevelInfo } = await import(
      new URL("../packages/mapelix-scene-prototype/dist/world/level-info.js", import.meta.url).href
    );
    const { spawn } = await readLevelInfo(join(worldData(config), "world"));
    view.set("x", String(spawn.x));
    view.set("z", String(spawn.z));
    view.set("scale", "3");
  } catch {
    // Without a readable spawn the viewer opens on its own default view.
  }
  return view.toString();
}

/** Addresses on the home network, leaving out virtual machines, containers and VPNs. */
function lanAddresses(port) {
  const virtual = /vEthernet|WSL|Hyper-V|docker|br-|veth|virbr|VirtualBox|VMware|Tailscale|ZeroTier|tun|utun/i;
  const home = /^(?:192\.168\.|10\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  return Object.entries(networkInterfaces())
    .filter(([name]) => !virtual.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal && home.test(address.address))
    .map((address) => `http://${address.address}:${port}`);
}

// --- Main ----------------------------------------------------------------------------------

const config = await configure();
await mkdir(config.data, { recursive: true });
await build(config.data);
await update(config);

let server = startServer(config);
const stop = () => {
  server.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await waitFor(config.port);

const local = `http://localhost:${config.port}`;
console.log(`
✔ Mapelix is running.
  On this computer:  ${local}
${lanAddresses(config.port)
  .map((url) => `  On a phone (same Wi-Fi): ${url}`)
  .join("\n")}
  Block textures download on the first start, then turn on by themselves.
  Leave this window open while you use the map; close it (or press Ctrl+C) to stop.`);
if (!flag("no-open")) open(`${local}/?${await startView(config)}`);

if (config.refresh > 0) {
  for (;;) {
    await new Promise((wake) => setTimeout(wake, config.refresh * 60_000));
    say("Time to update the map: the viewer stops for a moment…");
    server.kill();
    await update(config);
    server = startServer(config);
    await waitFor(config.port);
    say("Map updated. Reload the page to see it.");
  }
}
