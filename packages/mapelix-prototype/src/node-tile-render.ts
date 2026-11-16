import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { readLevelDbRecords, type NamedLevelDbFile } from "./bedrock/record-source.js";
import type { RenderedTile, TileCoordinates } from "./tile.js";
import type { SurfaceRange } from "./surface-range.js";
import type { SurfaceStyle } from "./surface-style.js";
import {
  createBedrockWorld,
  type EffectiveBedrockRecord,
  type RenderTileOptions,
} from "./world.js";

export interface PackedKeyGroup {
  readonly bytes: Uint8Array;
  readonly keyLength: number;
}

export interface IndexedTileSource {
  readonly name: string;
  readonly keyGroups: readonly PackedKeyGroup[];
}

export interface IndexedTileRenderJob {
  readonly coordinates: TileCoordinates;
  readonly databaseDirectory: string;
  readonly sources: readonly IndexedTileSource[];
  readonly biomeRecords: readonly EffectiveBedrockRecord[];
  readonly surfaceRange?: SurfaceRange;
  readonly surfaceStyle?: SurfaceStyle;
  readonly options?: Pick<
    RenderTileOptions,
    "shadows" | "biomeBlendRadius" | "correctReferenceBugs" | "includeSurface"
  >;
}

export async function renderIndexedTile(
  job: IndexedTileRenderJob,
  options: RenderTileOptions = {},
  signal?: AbortSignal,
): Promise<RenderedTile> {
  signal?.throwIfAborted();
  const records: EffectiveBedrockRecord[] = job.biomeRecords.map((record) => {
    const value = new Uint8Array(512 + record.value.byteLength);
    value.set(record.value, 512);
    return { key: record.key, value };
  });

  for (const source of job.sources) {
    const keys = new Set<string>();
    for (const group of source.keyGroups) {
      for (let offset = 0; offset < group.bytes.byteLength; offset += group.keyLength) {
        keys.add(hex(group.bytes.subarray(offset, offset + group.keyLength)));
      }
    }
    const file: NamedLevelDbFile = {
      name: source.name,
      bytes: await readFile(join(job.databaseDirectory, source.name), { signal }),
    };
    signal?.throwIfAborted();
    records.push(
      ...readLevelDbRecords([file], {
        includeKey: (key) => keys.has(hex(key)),
      }),
    );
  }

  const world = createBedrockWorld(records);
  try {
    signal?.throwIfAborted();
    const tile = await world.renderTile(job.coordinates, {
      ...job.options,
      ...options,
      ...(job.surfaceRange === undefined ? {} : { surfaceRange: job.surfaceRange }),
      ...(job.surfaceStyle === undefined ? {} : { surfaceStyle: job.surfaceStyle }),
    });
    signal?.throwIfAborted();
    return tile;
  } finally {
    await world.close();
  }
}

function hex(bytes: Uint8Array): string {
  let encoded = "";
  for (const byte of bytes) {
    encoded += HEX_BYTES[byte];
  }
  return encoded;
}

const HEX_BYTES = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, "0"));
