// Assembles a self-contained Mapelix release from a built checkout:
//
//   release.json                    commit, entry paths, format and API versions, a SHA-256 per file
//   node_modules/@mapelix/viewer/   the scene server and handlers (import "@mapelix/viewer/node")
//   node_modules/@mapelix/render-cli/, core/, prototype/, scene-prototype/
//                                   the 2D renderer CLI and the engine modules both sides import
//   node_modules/pako/, pngjs/      the two third-party runtime dependencies
//   viewer/mapelix-viewer.js, .css  the browser bundle and its styles
//   notices/                        licenses of the bundled code
//
// Usage: node scripts/pack-release.mjs <empty output directory> [--allow-dirty]
// Build first:
//   pnpm turbo run build --filter=@mapelix/viewer... --filter=@mapelix/render-cli...
//   pnpm --filter @mapelix/viewer build:embed
// Nothing here records a time or a machine path, so the same commit packs the same bytes.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const viewerPackage = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(viewerPackage, "../..");
const args = process.argv.slice(2);
const allowDirty = args.includes("--allow-dirty");
const output = args.find((arg) => !arg.startsWith("--"));
if (output === undefined) {
  throw new Error("Usage: pack-release.mjs <output directory> [--allow-dirty]");
}
const target = resolve(output);

const git = (...parameters) =>
  execFileSync("git", ["-C", repository, ...parameters], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
if (dirty && !allowDirty) {
  throw new Error("The checkout has uncommitted changes; a release must come from a commit");
}

const existing = await readdir(target).catch(() => []);
if (existing.length > 0) throw new Error(`${target} must be empty`);

const pnpmModules = join(repository, "node_modules", ".pnpm");
const installed = await readdir(pnpmModules);
/** The folder of an exact third-party version in the pnpm store. */
function thirdParty(name, version) {
  if (!installed.includes(`${name}@${version}`)) {
    throw new Error(`${name} ${version} is not installed; run pnpm install`);
  }
  return join(pnpmModules, `${name}@${version}`, "node_modules", name);
}
const pako = thirdParty("pako", "2.1.0");
const pngjs = thirdParty("pngjs", "7.0.0");
const three = thirdParty("three", "0.186.0");

/** Copies files under `from` whose relative path passes `keep`, into `to`. */
async function copyTree(from, to, keep, root = from) {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    if (entry.isDirectory()) {
      await copyTree(source, join(to, entry.name), keep, root);
    } else if (entry.isFile() && keep(relative(root, source))) {
      await mkdir(to, { recursive: true });
      await copyFile(source, join(to, entry.name));
    }
  }
}

async function requireFile(path, hint) {
  const details = await stat(path).catch(() => undefined);
  if (details?.isFile() !== true) throw new Error(`${path} is missing: ${hint}`);
}

const packages = {
  core: join(repository, "packages", "mapelix-core"),
  prototype: join(repository, "packages", "mapelix-prototype"),
  "scene-prototype": join(repository, "packages", "mapelix-scene-prototype"),
  "render-cli": join(repository, "apps", "render-cli"),
};
const embed = join(viewerPackage, "dist-embed");
const build = "run the builds listed at the top of this script";
await requireFile(join(viewerPackage, "dist", "node", "index.js"), build);
await requireFile(join(packages.core, "dist", "node", "snapshot.js"), build);
await requireFile(join(packages["render-cli"], "dist", "snapshot-cli.js"), build);
for (const directory of Object.values(packages)) {
  await requireFile(join(directory, "dist", "index.js"), build);
}
await requireFile(join(embed, "mapelix-viewer.js"), build);
await requireFile(join(embed, "mapelix-viewer.css"), build);

// Only compiled modules ship: the engine fingerprints hash `.js` files, so a release and the
// checkout it came from name the same revisions.
const javascript = (path) => path.endsWith(".js") && !path.endsWith(".test.js");
// The compiler never removes the output of a deleted source; such a leftover would ship and
// change the revisions.
for (const directory of [...Object.values(packages), viewerPackage]) {
  const output = join(directory, "dist");
  const leftovers = [];
  for (const path of (await listFiles(output)).map((file) => relative(output, file))) {
    const source = join(directory, "src", path.replace(/\.js$/, ".ts"));
    if (javascript(path) && (await stat(source).catch(() => undefined)) === undefined) {
      leftovers.push(path);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `${join(directory, "dist")} has output without a source (${leftovers.join(", ")}); delete it and build again`,
    );
  }
}
const modules = join(target, "node_modules");
for (const [name, directory] of Object.entries(packages)) {
  const into = join(modules, "@mapelix", name);
  await copyTree(join(directory, "dist"), join(into, "dist"), javascript);
  await copyFile(join(directory, "package.json"), join(into, "package.json"));
}

// The viewer's browser entries ship as the bundle; its package here serves the Node entry only.
const viewerManifest = JSON.parse(await readFile(join(viewerPackage, "package.json"), "utf8"));
const viewerModule = join(modules, "@mapelix", "viewer");
await copyTree(join(viewerPackage, "dist", "node"), join(viewerModule, "dist", "node"), javascript);
await writeFile(
  join(viewerModule, "package.json"),
  `${JSON.stringify(
    {
      name: viewerManifest.name,
      version: viewerManifest.version,
      type: "module",
      exports: { "./node": viewerManifest.exports["./node"] },
    },
    null,
    2,
  )}\n`,
);

await copyTree(pako, join(modules, "pako"), (path) =>
  ["package.json", "LICENSE", join("dist", "pako.esm.mjs")].includes(path),
);
await copyTree(
  pngjs,
  join(modules, "pngjs"),
  (path) =>
    ["package.json", "LICENSE"].includes(path) ||
    (path.startsWith(`lib${sep}`) && path.endsWith(".js")),
);

await mkdir(join(target, "viewer"), { recursive: true });
await copyFile(join(embed, "mapelix-viewer.js"), join(target, "viewer", "mapelix-viewer.js"));
await copyFile(join(embed, "mapelix-viewer.css"), join(target, "viewer", "mapelix-viewer.css"));

const notices = join(target, "notices");
await mkdir(notices, { recursive: true });
await copyFile(join(repository, "THIRD_PARTY_NOTICES.md"), join(notices, "MAPELIX-THIRD-PARTY.md"));
await copyFile(join(pako, "LICENSE"), join(notices, "pako-LICENSE"));
await copyFile(join(pngjs, "LICENSE"), join(notices, "pngjs-LICENSE"));
await copyFile(join(three, "LICENSE"), join(notices, "three-LICENSE"));

const scene = (file) =>
  import(pathToFileURL(join(modules, "@mapelix", "scene-prototype", "dist", file)).href);
const { REGION_FORMAT_VERSION } = await scene("format.js");
const { DISCOVERY_SCHEMA_VERSION } = await scene("discoveries.js");
const { ATLAS_FORMAT_VERSION } = await scene("textures/atlas-format.js");
const { TEXTURE_PIPELINE_VERSION } = await scene("textures/resource-pack.js");
const snapshotApiPath = join(modules, "@mapelix", "core", "dist", "node", "snapshot.js");
const { SNAPSHOT_VALIDATION_VERSION, validateSnapshot } = await import(
  pathToFileURL(snapshotApiPath).href
);
if (typeof validateSnapshot !== "function")
  throw new Error("The snapshot validation API is missing");
const embedSource = await readFile(join(viewerPackage, "src", "embed.ts"), "utf8");
const embedVersion = /EMBED_API_VERSION = (\d+)/.exec(embedSource)?.[1];
if (embedVersion === undefined) throw new Error("EMBED_API_VERSION is missing from embed.ts");
const renderManifest = JSON.parse(
  await readFile(join(packages["render-cli"], "package.json"), "utf8"),
);
const mise = await readFile(join(repository, "mise.toml"), "utf8");
const nodeVersion = /node = "([^"]+)"/.exec(mise)?.[1];

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else files.push(path);
  }
  return files;
}
const files = [];
for (const path of await listFiles(target)) {
  const name = relative(target, path).split(sep).join("/");
  files.push([
    name,
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  ]);
}
files.sort(([left], [right]) => (left < right ? -1 : 1));

const posix = (path) => relative(target, path).split(sep).join("/");
const release = {
  name: "mapelix",
  commit,
  dirty,
  node: nodeVersion ?? ">=24",
  embedApiVersion: Number(embedVersion),
  regionFormatVersion: REGION_FORMAT_VERSION,
  discoverySchemaVersion: DISCOVERY_SCHEMA_VERSION,
  textureFormatVersion: ATLAS_FORMAT_VERSION,
  texturePipelineVersion: TEXTURE_PIPELINE_VERSION,
  renderCliVersion: renderManifest.version,
  renderCli: posix(join(modules, "@mapelix", "render-cli", renderManifest.bin["mapelix-render"])),
  snapshotValidationVersion: SNAPSHOT_VALIDATION_VERSION,
  snapshotValidationApi: posix(snapshotApiPath),
  snapshotValidationCli: {
    entry: posix(join(modules, "@mapelix", "render-cli", renderManifest.bin["mapelix-render"])),
    args: ["validate"],
  },
  sceneServer: posix(join(viewerModule, "dist", "node", "index.js")),
  textureCli: posix(join(viewerModule, "dist", "node", "texture-cli.js")),
  viewer: "viewer/mapelix-viewer.js",
  viewerStyles: "viewer/mapelix-viewer.css",
  files: Object.fromEntries(files),
};
await writeFile(join(target, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
console.log(
  `Packed Mapelix ${commit}${dirty ? " (dirty)" : ""}: ${files.length} files in ${target}`,
);
