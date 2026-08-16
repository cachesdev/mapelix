import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RenderedTile } from "./tile.js";

export interface LeafletTileOutput {
  readonly root: string;
}

export async function writeLeafletTile(
  tile: RenderedTile,
  output: LeafletTileOutput,
): Promise<string> {
  const directory = join(output.root, String(tile.coordinates.z), String(tile.coordinates.x));
  const path = join(directory, `${tile.coordinates.y}.png`);
  await mkdir(directory, { recursive: true });
  await writeFile(path, tile.png);
  return path;
}
