import { join } from "node:path";

import {
  SUBCHUNK_TAG,
  classifyMapRecordKey,
  visitLevelDbRecords,
} from "@mapelix/prototype/bedrock";
import {
  openLevelDbSnapshot,
  readLevelDbSnapshotFile,
  levelDbFileError,
} from "@mapelix/prototype/node/leveldb";
import type { Dimension } from "@mapelix/scene-prototype";

import type { BlockBounds } from "./bounds.js";

const DIMENSION_IDS: Readonly<Record<Dimension, number>> = {
  overworld: 0,
  nether: 1,
  "the-end": 2,
};

/** The stored area of each dimension, or undefined for a dimension without chunks. */
export type WorldExtent = Readonly<Record<Dimension, BlockBounds | undefined>>;

/**
 * Finds the blocks each dimension stores by reading every database key once.
 * Values are never decoded. Deleted keys are skipped; an older copy of a deleted
 * chunk can still widen the extent a little, which only costs an empty region.
 */
export async function scanWorldExtent(worldDirectory: string): Promise<WorldExtent> {
  const database = join(worldDirectory, "db");
  const chunks = new Map<number, { minX: number; minZ: number; maxX: number; maxZ: number }>();
  const snapshot = openLevelDbSnapshot(worldDirectory);
  for (const file of snapshot.files) {
    const bytes = await readLevelDbSnapshotFile(database, file);
    try {
      visitLevelDbRecords(
        { name: file.name, bytes },
        (key, value) => {
          if (value === undefined) return;
          const parsed = classifyMapRecordKey(key);
          if (parsed === undefined || parsed.tag !== SUBCHUNK_TAG) return;
          const area = chunks.get(parsed.dimension);
          if (area === undefined) {
            chunks.set(parsed.dimension, {
              minX: parsed.x,
              minZ: parsed.z,
              maxX: parsed.x,
              maxZ: parsed.z,
            });
            return;
          }
          area.minX = Math.min(area.minX, parsed.x);
          area.minZ = Math.min(area.minZ, parsed.z);
          area.maxX = Math.max(area.maxX, parsed.x);
          area.maxZ = Math.max(area.maxZ, parsed.z);
        },
        { verifyChecksums: true },
      );
    } catch (cause) {
      throw levelDbFileError(file, cause);
    }
  }
  const blocks = (dimension: Dimension): BlockBounds | undefined => {
    const area = chunks.get(DIMENSION_IDS[dimension]);
    return area === undefined
      ? undefined
      : {
          minX: area.minX * 16,
          minZ: area.minZ * 16,
          maxX: area.maxX * 16 + 15,
          maxZ: area.maxZ * 16 + 15,
        };
  };
  return { overworld: blocks("overworld"), nether: blocks("nether"), "the-end": blocks("the-end") };
}

/** Reads a cached extent, returning undefined when the file is missing or malformed. */
export function parseExtent(text: string): WorldExtent | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const read = (name: Dimension): BlockBounds | undefined | false => {
      const raw = record[name];
      if (raw === null || raw === undefined) return undefined;
      if (typeof raw !== "object") return false;
      const bounds = raw as Record<string, unknown>;
      const numbers = ["minX", "minZ", "maxX", "maxZ"].map((key) => bounds[key]);
      if (!numbers.every((number) => Number.isSafeInteger(number))) return false;
      const [minX, minZ, maxX, maxZ] = numbers as [number, number, number, number];
      return minX <= maxX && minZ <= maxZ ? { minX, minZ, maxX, maxZ } : false;
    };
    const overworld = read("overworld");
    const nether = read("nether");
    const end = read("the-end");
    if (overworld === false || nether === false || end === false) return undefined;
    return { overworld, nether, "the-end": end };
  } catch {
    return undefined;
  }
}

/** Whether a region square of `span` blocks at region coordinates x, z touches the bounds. */
export function regionTouches(bounds: BlockBounds, span: number, x: number, z: number): boolean {
  const minX = x * span;
  const minZ = z * span;
  return (
    minX <= bounds.maxX &&
    minX + span - 1 >= bounds.minX &&
    minZ <= bounds.maxZ &&
    minZ + span - 1 >= bounds.minZ
  );
}
