// Synthetic resource packs for tests: generated textures only, never real game assets.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { encodePng } from "@mapelix/prototype/png";

export interface ZipFileSpec {
  readonly name: string;
  readonly data: Uint8Array | string;
  /** 0 stored, 8 deflated (default). */
  readonly method?: number;
  /** Overrides written into both headers, to forge damaged or malicious archives. */
  readonly declaredSize?: number;
  readonly crc?: number;
  readonly flags?: number;
}

const bytesOf = (data: Uint8Array | string): Uint8Array =>
  typeof data === "string" ? new TextEncoder().encode(data) : data;

/** Writes a zip archive in memory. */
export function makeZip(files: readonly ZipFileSpec[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const data = bytesOf(file.data);
    const method = file.method ?? 8;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const name = new TextEncoder().encode(file.name);
    const crc = file.crc ?? crc32(data);
    const size = file.declaredSize ?? data.byteLength;
    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x0403_4b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, file.flags ?? 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.byteLength, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.byteLength);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x0201_4b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, file.flags ?? 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, stored.byteLength, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.byteLength, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, stored);
    centrals.push(central);
    offset += local.byteLength + stored.byteLength;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x0605_4b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  const parts = [...locals, ...centrals, end];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** A square texture whose pixels encode `seed`, so tests can tell textures apart. */
export function solidRgba(
  size: number,
  rgba: readonly [number, number, number, number],
): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index++) out.set(rgba, index * 4);
  return out;
}

export function makePng(
  size: number,
  rgba: readonly [number, number, number, number],
  height = size,
): Uint8Array {
  const pixels = new Uint8Array(size * height * 4);
  for (let index = 0; index < size * height; index++) pixels.set(rgba, index * 4);
  return encodePng(pixels, size, height);
}

/** An uncompressed 32-bit TGA, rows from the top. */
export function makeTga(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(18 + width * height * 4);
  out[2] = 2;
  out[12] = width & 0xff;
  out[13] = width >> 8;
  out[14] = height & 0xff;
  out[15] = height >> 8;
  out[16] = 32;
  out[17] = 0x28; // Top-left origin, eight alpha bits.
  for (let index = 0; index < width * height; index++) {
    out[18 + index * 4] = rgba[index * 4 + 2]!;
    out[18 + index * 4 + 1] = rgba[index * 4 + 1]!;
    out[18 + index * 4 + 2] = rgba[index * 4]!;
    out[18 + index * 4 + 3] = rgba[index * 4 + 3]!;
  }
  return out;
}

export interface SyntheticPackOptions {
  readonly name?: string;
  readonly uuid?: string;
  readonly version?: readonly number[];
  readonly terrain?: Record<string, unknown>;
  readonly blocks?: Record<string, unknown>;
  readonly flipbooks?: readonly unknown[];
  /** Image files by path with extension, under the pack root. */
  readonly images?: Record<string, Uint8Array>;
}

/** The files of a pack (path → content), ready for a folder or a zip. */
export function packFiles(options: SyntheticPackOptions = {}): ZipFileSpec[] {
  const manifest = {
    format_version: 2,
    header: {
      name: options.name ?? "Synthetic pack",
      uuid: options.uuid ?? "00000000-0000-4000-8000-000000000001",
      version: options.version ?? [1, 0, 0],
    },
    modules: [
      { type: "resources", uuid: "00000000-0000-4000-8000-0000000000ff", version: [1, 0, 0] },
    ],
  };
  const files: ZipFileSpec[] = [
    { name: "manifest.json", data: `// generated\n${JSON.stringify(manifest, null, 2)}` },
  ];
  if (options.terrain !== undefined) {
    files.push({
      name: "textures/terrain_texture.json",
      data: JSON.stringify({ resource_pack_name: "synthetic", texture_data: options.terrain }),
    });
  }
  if (options.blocks !== undefined) {
    files.push({
      name: "blocks.json",
      data: JSON.stringify({ format_version: [1, 1, 0], ...options.blocks }),
    });
  }
  if (options.flipbooks !== undefined) {
    files.push({
      name: "textures/flipbook_textures.json",
      data: JSON.stringify(options.flipbooks),
    });
  }
  for (const [name, data] of Object.entries(options.images ?? {})) files.push({ name, data });
  return files;
}

export async function writePackFolder(root: string, files: readonly ZipFileSpec[]): Promise<void> {
  for (const file of files) {
    const path = join(root, ...file.name.split("/"));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytesOf(file.data));
  }
}
