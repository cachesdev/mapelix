import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MODERN_SURFACE_STYLE } from "../../surface-appearance.js";
import { jsonBytes, sha256 } from "../snapshot-identity.js";
export { identifyFile, jsonBytes, sha256, sourceIdentity } from "../snapshot-identity.js";

export async function rendererIdentity(): Promise<{ revision: string; appearanceSha256: string }> {
  const digest = createHash("sha256");
  async function addTree(root: string, prefix: string): Promise<void> {
    async function visit(directory: string): Promise<void> {
      const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(".js")) {
          digest.update(`${prefix}/${relative(root, path).split(sep).join("/")}\0`);
          digest.update((await readFile(path, "utf8")).replaceAll("\r\n", "\n"));
          digest.update("\0");
        }
      }
    }
    await visit(root);
  }
  await addTree(fileURLToPath(new URL("../../", import.meta.url)), "core");
  await addTree(
    fileURLToPath(new URL("./", import.meta.resolve("@mapelix/prototype"))),
    "prototype",
  );
  digest.update(jsonBytes({ node: process.versions.node, zlib: process.versions.zlib }));
  return {
    revision: digest.digest("hex"),
    appearanceSha256: sha256(JSON.stringify(MODERN_SURFACE_STYLE)),
  };
}
