import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import setupWorld from "../../prototype-viewer-3d/tests/setup-world";

/** Renders the shared fixture world once, unless a tile export is given. */
export default async function setupTiles(): Promise<void> {
  if (process.env.MAPELIX_E2E_TILES_DIRECTORY) return;
  const output = resolve("../../.local/demo-export");
  if (
    await access(join(output, "manifest.json")).then(
      () => true,
      () => false,
    )
  )
    return;
  await setupWorld();
  await mkdir(dirname(output), { recursive: true });
  await promisify(execFile)(process.execPath, [
    resolve("../render-cli/dist/index.js"),
    "--world",
    resolve("../../.local/dimension-world"),
    "--output",
    output,
    "--dimension",
    "overworld,nether",
    "--workers",
    "1",
  ]);
}
