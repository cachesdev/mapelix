import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

import { RATIO_FLOOR_BYTES, ResourcePackError, packPath, type PackLimits } from "./pack-limits.js";

/** The files of one pack, from a folder or an archive, under normalized relative paths. */
export interface PackFiles {
  /** The folder or file name, for messages. */
  readonly label: string;
  /** Every file, mapped to its uncompressed size. */
  readonly sizes: ReadonlyMap<string, number>;
  read(path: string): Promise<Uint8Array>;
  /** A digest of the file's content, cheap for archives (stored size and CRC-32). */
  digest(path: string): Promise<string>;
}

/** Opens a folder, or a zip or `.mcpack` file, as the files of one pack. */
export async function openPackFiles(source: string, limits: PackLimits): Promise<PackFiles> {
  const label = basename(source);
  const details = await lstat(source).catch(() => undefined);
  if (details === undefined) throw new ResourcePackError(label, "is missing");
  if (details.isDirectory()) return openFolder(source, label, limits);
  if (!details.isFile()) throw new ResourcePackError(label, "is neither a folder nor a file");
  if (details.size > limits.maxArchiveBytes) {
    throw new ResourcePackError(label, `is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const handle = await open(source, "r");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(details.size);
    const { bytesRead } = await handle.read(bytes, 0, details.size, 0);
    if (bytesRead !== details.size) throw new ResourcePackError(label, "changed while read");
  } finally {
    await handle.close();
  }
  return openZip(bytes, label, limits);
}

/** Restricts `files` to the folder `prefix` inside it (`a/b`), which becomes the root. */
export function packSubfolder(files: PackFiles, prefix: string): PackFiles {
  if (prefix === "") return files;
  const start = `${prefix}/`;
  const sizes = new Map<string, number>();
  for (const [path, size] of files.sizes) {
    if (path.startsWith(start)) sizes.set(path.slice(start.length), size);
  }
  return {
    label: `${files.label}/${prefix}`,
    sizes,
    read: (path) => files.read(start + path),
    digest: (path) => files.digest(start + path),
  };
}

async function openFolder(root: string, label: string, limits: PackLimits): Promise<PackFiles> {
  const sizes = new Map<string, number>();
  let total = 0;
  let entries = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const listed = await readdir(directory, { withFileTypes: true });
    for (const entry of listed) {
      entries += 1;
      if (entries > limits.maxEntries) {
        throw new ResourcePackError(label, `has more than ${limits.maxEntries} entries`);
      }
      // Links are never followed, so nothing outside the folder is reachable.
      if (entry.isSymbolicLink()) continue;
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relative);
      } else if (entry.isFile()) {
        let path: string | undefined;
        try {
          path = packPath(relative);
        } catch {
          continue;
        }
        if (path === undefined) continue;
        const { size } = await lstat(join(directory, entry.name));
        total += size;
        if (total > limits.maxTotalBytes) {
          throw new ResourcePackError(label, `holds more than ${limits.maxTotalBytes} bytes`);
        }
        sizes.set(path, size);
      }
    }
  }
  await visit(root, "");

  async function read(path: string): Promise<Uint8Array> {
    const size = sizes.get(path);
    if (size === undefined) throw new ResourcePackError(label, "is missing", path);
    if (size > limits.maxFileBytes) {
      throw new ResourcePackError(label, `is larger than ${limits.maxFileBytes} bytes`, path);
    }
    const file = join(root, ...path.split("/"));
    const details = await lstat(file);
    if (!details.isFile() || details.size !== size) {
      throw new ResourcePackError(label, "changed while the pack was open", path);
    }
    const handle = await open(file, "r");
    try {
      const bytes = new Uint8Array(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      if (bytesRead !== size) throw new ResourcePackError(label, "changed while read", path);
      return bytes;
    } finally {
      await handle.close();
    }
  }
  return {
    label,
    sizes,
    read,
    digest: async (path) =>
      createHash("sha256")
        .update(await read(path))
        .digest("hex"),
  };
}

interface ZipEntry {
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
}

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;

/** Reads a zip archive's directory. Only stored and deflated, unencrypted, non-ZIP64 entries. */
export function openZip(bytes: Uint8Array, label: string, limits: PackLimits): PackFiles {
  const fail = (message: string, file?: string): never => {
    throw new ResourcePackError(label, message, file);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let at = bytes.byteLength - 22; at >= Math.max(0, bytes.byteLength - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) fail("is not a zip archive or a folder");
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) {
    fail("spans several disks");
  }
  const count = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || directoryOffset === 0xffff_ffff || directorySize === 0xffff_ffff) {
    fail("uses ZIP64, which is not supported");
  }
  if (count > limits.maxEntries) fail(`has more than ${limits.maxEntries} entries`);
  if (directoryOffset + directorySize > eocd) fail("has a central directory outside the file");

  const entries = new Map<string, ZipEntry>();
  const sizes = new Map<string, number>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      fail("has a damaged central directory");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > eocd) fail("has a damaged central directory");
    let raw: string;
    try {
      raw = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    } catch {
      raw = fail("has a file name that is not UTF-8");
    }
    at = end;
    let path: string | undefined;
    try {
      path = packPath(raw);
    } catch (error) {
      fail(`has an unsafe entry name: ${(error as Error).message}`, raw);
    }
    if (path === undefined) continue;
    if ((flags & 1) !== 0) fail("is encrypted", path);
    if (size === 0xffff_ffff || compressedSize === 0xffff_ffff || localOffset === 0xffff_ffff) {
      fail("uses ZIP64, which is not supported", path);
    }
    if (entries.has(path)) fail("appears twice", path);
    if (size > RATIO_FLOOR_BYTES && size > compressedSize * limits.maxCompressionRatio) {
      fail(`compresses more than ${limits.maxCompressionRatio} to 1`, path);
    }
    total += size;
    if (total > limits.maxTotalBytes) fail(`holds more than ${limits.maxTotalBytes} bytes`);
    entries.set(path, { method, crc, compressedSize, size, localOffset });
    sizes.set(path, size);
  }

  async function read(path: string): Promise<Uint8Array> {
    const entry = entries.get(path) ?? fail("is missing", path);
    if (entry.size > limits.maxFileBytes) {
      fail(`is larger than ${limits.maxFileBytes} bytes`, path);
    }
    const local = entry.localOffset;
    if (local + 30 > bytes.byteLength || view.getUint32(local, true) !== LOCAL_SIGNATURE) {
      fail("has a damaged local header", path);
    }
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + entry.compressedSize > bytes.byteLength) fail("is truncated", path);
    const data = bytes.subarray(start, start + entry.compressedSize);
    let content: Uint8Array;
    if (entry.method === 0) {
      if (entry.compressedSize !== entry.size) fail("has inconsistent sizes", path);
      content = data;
    } else if (entry.method === 8) {
      try {
        // The declared size bounds the output, so a lying header cannot inflate further.
        content = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.size) });
      } catch {
        content = fail("does not inflate to its declared size", path);
      }
      if (content.byteLength !== entry.size) fail("does not inflate to its declared size", path);
    } else {
      content = fail(`uses compression method ${entry.method}, which is not supported`, path);
    }
    if (crc32(content) !== entry.crc) fail("fails its CRC-32 check", path);
    return new Uint8Array(content);
  }
  return {
    label,
    sizes,
    read,
    digest: async (path) => {
      const entry = entries.get(path) ?? fail("is missing", path);
      return `${entry.size.toString(16)}-${entry.crc.toString(16).padStart(8, "0")}`;
    },
  };
}
