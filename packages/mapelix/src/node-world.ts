import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { readLevelDbRecords, type NamedLevelDbFile } from "./bedrock/record-source.js";
import { createBedrockWorld, type BedrockWorld } from "./world.js";

export interface BedrockWorldDirectory {
  readonly directory: string;
}

/** Opens an extracted Minecraft Bedrock world directory. */
export async function openBedrockWorld(input: BedrockWorldDirectory): Promise<BedrockWorld> {
  const databaseDirectory = join(input.directory, "db");
  const entries = await readdir(databaseDirectory, { withFileTypes: true });
  const databaseFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ldb") || entry.name.endsWith(".sst") || entry.name.endsWith(".log")),
    )
    .sort((left, right) => left.name.localeCompare(right.name));

  const files: NamedLevelDbFile[] = await Promise.all(
    databaseFiles.map(async (entry) => ({
      name: entry.name,
      bytes: await readFile(join(databaseDirectory, entry.name)),
    })),
  );
  return createBedrockWorld(readLevelDbRecords(files));
}
