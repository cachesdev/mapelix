import type { DecodedSubchunk } from "@mapelix/prototype/bedrock";
import { resolveBlockAppearance } from "../blocks/block-appearance.js";
import {
  assertDiscoveryRequest,
  discoveryKind,
  encodeDiscoveryTile,
  packDiscoveryBlock,
  type DiscoveryRequest,
  type Exposure,
} from "../discoveries.js";
import { type ChunkSource, type DecodedChunk } from "./chunk-source.js";

const NEIGHBORS = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;
interface Column {
  readonly chunk: DecodedChunk;
  readonly sections: Map<number, DecodedSubchunk>;
}

/** Index one 32x32 source tile at all heights, without allocating or traversing a mesh. */
export function buildDiscoveryIndex(source: ChunkSource, request: DiscoveryRequest): Uint8Array {
  assertDiscoveryRequest(request);
  const { minY, maxY, dimension } = source.config;
  // At most the owned 2x2 columns plus their one-column neighbor ring (16 columns).
  // This job-local map is released after encoding; decoded source sections retain their bounded LRU.
  const columns = new Map<string, Column | undefined>();
  const opaque = new Map<string, boolean>();
  const column = (x: number, z: number): Column | undefined => {
    const key = `${x}/${z}`;
    if (columns.has(key)) return columns.get(key);
    const chunk = source.chunkRange(x, z, minY, maxY);
    const value = chunk
      ? { chunk, sections: new Map(chunk.sections.map((s) => [s.y, s])) }
      : undefined;
    columns.set(key, value);
    return value;
  };
  const solid = (x: number, y: number, z: number): boolean | undefined => {
    if (y < minY || y >= maxY) return false;
    const c = column(Math.floor(x / 16), Math.floor(z / 16));
    if (!c) return undefined;
    const s = c.sections.get(Math.floor(y / 16));
    if (!s) return false;
    const index = ((x & 15) << 8) | ((z & 15) << 4) | (y & 15);
    const id = s.primary.indexes[index]!,
      name = s.primary.palette[id];
    if (name === undefined) return undefined;
    const states = s.primary.states?.[id] ?? {};
    const key = `${name}/${JSON.stringify(states)}`;
    let value = opaque.get(key);
    if (value === undefined) {
      const shape = resolveBlockAppearance(name, states).shape.kind;
      value = shape === "cube" || shape === "lava";
      opaque.set(key, value);
    }
    return value;
  };
  const exposure = (x: number, y: number, z: number): Exposure => {
    let unknown = false;
    for (const [dx, dy, dz] of NEIGHBORS) {
      const neighbor = solid(x + dx, y + dy, z + dz);
      if (neighbor === false) return "exposed";
      if (neighbor === undefined) unknown = true;
    }
    return unknown ? "unknown" : "buried";
  };
  const blocks: number[] = [];
  let sourceChunks = 0;
  for (let cz = 0; cz < 2; cz++)
    for (let cx = 0; cx < 2; cx++) {
      const chunkX = request.x * 2 + cx,
        chunkZ = request.z * 2 + cz;
      const c = column(chunkX, chunkZ);
      if (!c) continue;
      sourceChunks |= 1 << (cz * 2 + cx);
      for (const s of c.chunk.sections) {
        const kinds = s.primary.palette.map(discoveryKind);
        if (kinds.every((value) => value === undefined)) continue;
        for (let index = 0; index < 4096; index++) {
          const kind = kinds[s.primary.indexes[index]!];
          if (kind === undefined) continue;
          const x = chunkX * 16 + (index >> 8),
            y = s.y * 16 + (index & 15),
            z = chunkZ * 16 + ((index >> 4) & 15);
          if (y < minY || y >= maxY) continue;
          blocks.push(packDiscoveryBlock(x & 31, y, z & 31, kind, exposure(x, y, z)));
        }
      }
    }
  return encodeDiscoveryTile({
    ...request,
    dimension,
    sourceChunks,
    blocks: Uint32Array.from(blocks),
  });
}
