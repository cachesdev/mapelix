import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

import {
  RATIO_FLOOR_BYTES,
  ResourcePackChangedError,
  ResourcePackError,
  packPath,
  type PackLimits,
} from "./pack-limits.js";

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

/** Bytes that can be read at any offset, so an archive is never held whole in memory. */
export interface RandomAccess {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

/** Random access to bytes already in memory. */
export function bytesAccess(bytes: Uint8Array): RandomAccess {
  return {
    size: bytes.byteLength,
    read: async (offset, length) =>
      bytes.subarray(offset, Math.min(bytes.byteLength, offset + length)),
  };
}

/** Random access to a file, opened for each read; a file that changes size is refused. */
function fileAccess(path: string, size: number, label: string): RandomAccess {
  return {
    size,
    read: async (offset, length) => {
      const handle = await open(path, "r");
      try {
        if ((await handle.stat()).size !== size) {
          throw new ResourcePackChangedError(label, "changed while the pack was open");
        }
        const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
        const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, offset);
        return bytes.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
  };
}

/**
 * Opens a folder, or a zip or `.mcpack` file, as the files of one pack. Links are refused, the
 * pack itself included, so nothing outside the given path is ever read.
 */
export async function openPackFiles(source: string, limits: PackLimits): Promise<PackFiles> {
  const label = basename(source);
  const details = await lstat(source).catch(() => undefined);
  if (details === undefined) throw new ResourcePackError(label, "is missing");
  if (details.isSymbolicLink()) throw new ResourcePackError(label, "is a link, which is refused");
  if (details.isDirectory()) return openFolder(source, label, limits);
  if (!details.isFile()) throw new ResourcePackError(label, "is neither a folder nor a file");
  if (details.size > limits.maxArchiveBytes) {
    throw new ResourcePackError(label, `is larger than ${limits.maxArchiveBytes} bytes`);
  }
  return openZip(fileAccess(source, details.size, label), label, limits);
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
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // A link could lead outside the folder: the whole pack is refused.
      if (entry.isSymbolicLink()) {
        throw new ResourcePackError(label, "holds a link, which is refused", relative);
      }
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
    if (details.isSymbolicLink() || !details.isFile() || details.size !== size) {
      throw new ResourcePackChangedError(label, "changed while the pack was open", path);
    }
    const handle = await open(file, "r");
    try {
      const bytes = new Uint8Array(size);
      const { bytesRead } = await handle.read(bytes, 0, size, 0);
      if (bytesRead !== size) throw new ResourcePackChangedError(label, "changed while read", path);
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

/** Largest central directory read; 65,536 entries with long names fit well within it. */
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;

/**
 * Reads a zip archive's directory, then each entry on demand: only the directory and the entry
 * being read are in memory. Only stored and deflated, unencrypted, non-ZIP64 entries.
 */
export async function openZip(
  source: Uint8Array | RandomAccess,
  label: string,
  limits: PackLimits,
): Promise<PackFiles> {
  const access = source instanceof Uint8Array ? bytesAccess(source) : source;
  const fail = (message: string, file?: string): never => {
    throw new ResourcePackError(label, message, file);
  };
  const tailStart = Math.max(0, access.size - 22 - 65_535);
  const tail = await access.read(tailStart, access.size - tailStart);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let at = tail.byteLength - 22; at >= 0; at--) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) {
      end = at;
      break;
    }
  }
  if (end < 0) fail("is not a zip archive or a folder");
  const eocd = tailStart + end;
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) {
    fail("spans several disks");
  }
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffff_ffff || directorySize === 0xffff_ffff) {
    fail("uses ZIP64, which is not supported");
  }
  if (count > limits.maxEntries) fail(`has more than ${limits.maxEntries} entries`);
  if (directoryOffset + directorySize > eocd) fail("has a central directory outside the file");
  if (directorySize > MAX_DIRECTORY_BYTES) fail("has a central directory too large to read");
  const directory = await access.read(directoryOffset, directorySize);
  const listing = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);

  const entries = new Map<string, ZipEntry>();
  const sizes = new Map<string, number>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let at = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > directory.byteLength || listing.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      fail("has a damaged central directory");
    }
    const flags = listing.getUint16(at + 8, true);
    const method = listing.getUint16(at + 10, true);
    const crc = listing.getUint32(at + 16, true);
    const compressedSize = listing.getUint32(at + 20, true);
    const size = listing.getUint32(at + 24, true);
    const nameLength = listing.getUint16(at + 28, true);
    const extraLength = listing.getUint16(at + 30, true);
    const commentLength = listing.getUint16(at + 32, true);
    const localOffset = listing.getUint32(at + 42, true);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > directory.byteLength) fail("has a damaged central directory");
    let raw: string;
    try {
      raw = decoder.decode(directory.subarray(at + 46, at + 46 + nameLength));
    } catch {
      raw = fail("has a file name that is not UTF-8");
    }
    at = next;
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
    const header = await access.read(entry.localOffset, 30);
    const fields = new DataView(header.buffer, header.byteOffset, header.byteLength);
    if (header.byteLength < 30 || fields.getUint32(0, true) !== LOCAL_SIGNATURE) {
      fail("has a damaged local header", path);
    }
    const start = entry.localOffset + 30 + fields.getUint16(26, true) + fields.getUint16(28, true);
    if (start + entry.compressedSize > access.size) fail("is truncated", path);
    const data = await access.read(start, entry.compressedSize);
    if (data.byteLength !== entry.compressedSize) fail("is truncated", path);
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
