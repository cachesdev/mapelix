import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readLittleEndianNbtCompound } from "@mapelix/prototype/bedrock";

export interface LevelInfo {
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * Reads the world name and spawn point. `level.dat` starts with an eight-byte
 * header before its little-endian NBT root.
 */
export async function readLevelInfo(worldDirectory: string): Promise<LevelInfo> {
  const [levelName, levelData] = await Promise.all([
    readFile(join(worldDirectory, "levelname.txt"), "utf8").catch(() => undefined),
    readFile(join(worldDirectory, "level.dat")).catch(() => undefined),
  ]);

  const root =
    levelData === undefined ? undefined : readLittleEndianNbtCompound(levelData, 8).value;
  const integer = (key: string, fallback: number): number => {
    const value = root?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const storedName = root?.LevelName;
  const spawnY = integer("SpawnY", 64);
  return {
    name: levelName?.trim() || (typeof storedName === "string" ? storedName : "Bedrock world"),
    spawn: {
      x: integer("SpawnX", 0),
      // Bedrock stores 32767 when the spawn height has not been resolved yet.
      y: spawnY > 320 ? 64 : spawnY,
      z: integer("SpawnZ", 0),
    },
  };
}
