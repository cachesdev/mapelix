import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";

import {
  LevelDbSnapshotError,
  errorMessage,
  readLevelDbCurrent,
  readLevelDbManifest,
  selectLevelDbFiles,
  type LevelDbFileSelection,
  type LevelDbManifest,
  type SelectedLevelDbFile,
} from "./bedrock/leveldb-snapshot.js";

export { LevelDbSnapshotError } from "./bedrock/leveldb-snapshot.js";
export type { LevelDbSnapshotErrorCode } from "./bedrock/leveldb-snapshot.js";

export interface LevelDbSnapshotOptions {
  readonly maxFileBytes?: number;
  readonly signal?: AbortSignal;
}

export interface LevelDbSnapshot extends LevelDbFileSelection {
  readonly manifest: LevelDbManifest;
  readonly manifestName: string;
  readonly currentBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly LevelDbSnapshotFile[];
}

export interface LevelDbSnapshotFile extends SelectedLevelDbFile {
  /** Logical length; table lengths come from the manifest, WAL lengths from the file. */
  readonly size: number;
}

/** Metadata only: tables are not read and no file is opened for writing. */
export function openLevelDbSnapshot(
  worldDirectory: string,
  options: LevelDbSnapshotOptions = {},
): LevelDbSnapshot {
  options.signal?.throwIfAborted();
  const directory = join(worldDirectory, "db");
  let names: string[];
  try {
    assertNoLevelDbLinks(directory);
    names = readdirSync(directory);
  } catch (cause) {
    throw new LevelDbSnapshotError("SNAPSHOT_IO_ERROR", "db", errorMessage(cause), cause);
  }
  const currentBytes = readMetadata(directory, "CURRENT", 4096, "CURRENT_INVALID");
  const manifestName = readLevelDbCurrent(currentBytes);
  const manifestBytes = readMetadata(
    directory,
    manifestName,
    Math.min(options.maxFileBytes ?? Infinity, 64 * 1024 * 1024),
    "MANIFEST_INVALID",
  );
  options.signal?.throwIfAborted();
  const manifest = readLevelDbManifest(manifestBytes, manifestName);
  const selected = selectLevelDbFiles(manifest, names);
  const files = [...selected.tables, ...selected.logs].map((file): LevelDbSnapshotFile => {
    options.signal?.throwIfAborted();
    try {
      const path = join(directory, file.name);
      assertNoLevelDbLinks(path);
      const details = lstatSync(path);
      const size = file.kind === "table" ? file.size : details.size;
      if (!details.isFile() || details.size < size || !Number.isSafeInteger(size))
        throw new Error("active file is not a regular file or is shorter than its logical length");
      if (size > (options.maxFileBytes ?? Infinity))
        throw new Error("active file exceeds permitted bytes");
      return { name: file.name, number: file.number, kind: file.kind, size };
    } catch (cause) {
      throw levelDbFileError(file, cause);
    }
  });
  return { ...selected, manifest, manifestName, currentBytes, manifestBytes, files };
}

/** Checks ancestors too, including Windows junctions. No permission changes or lock files. */
export function assertNoLevelDbLinks(path: string): void {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const component of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`Symbolic links and junctions are not supported: ${current}`);
  }
}

/** Reads exactly a selected file's logical bytes, rejecting short reads. */
export async function readLevelDbSnapshotFile(
  directory: string,
  file: LevelDbSnapshotFile,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  try {
    const path = join(directory, file.name);
    assertNoLevelDbLinks(path);
    const handle = await open(path, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size < file.size)
        throw new Error("active file is not regular or is shorter than its logical length");
      if (file.kind === "log" && before.size !== file.size)
        throw new LevelDbSnapshotError(
          "SOURCE_CHANGED",
          file.name,
          "journal length changed after selection",
        );
      const bytes = new Uint8Array(file.size);
      let position = 0;
      while (position < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          bytes,
          position,
          Math.min(256 * 1024, bytes.length - position),
          position,
        );
        if (bytesRead === 0)
          throw new Error(`short LevelDB read: ${position} of ${file.size} bytes`);
        position += bytesRead;
      }
      const after = await handle.stat();
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new LevelDbSnapshotError(
          "SOURCE_CHANGED",
          file.name,
          "active file changed during reading",
        );
      return bytes;
    } finally {
      await handle.close();
    }
  } catch (cause) {
    signal?.throwIfAborted();
    throw levelDbFileError(file, cause);
  }
}

export function levelDbFileError(file: SelectedLevelDbFile, cause: unknown): LevelDbSnapshotError {
  if (cause instanceof LevelDbSnapshotError) return cause;
  const missing = cause instanceof Error && "code" in cause && cause.code === "ENOENT";
  const ioError =
    cause instanceof Error &&
    "code" in cause &&
    ["EACCES", "EPERM", "EIO", "EMFILE", "ENFILE"].includes(String(cause.code));
  return new LevelDbSnapshotError(
    ioError
      ? "SNAPSHOT_IO_ERROR"
      : missing
        ? "ACTIVE_FILE_MISSING"
        : file.kind === "table"
          ? "ACTIVE_TABLE_INVALID"
          : "REQUIRED_LOG_INVALID",
    file.name,
    errorMessage(cause),
    cause,
  );
}

function readMetadata(
  directory: string,
  name: string,
  limit: number,
  code: "CURRENT_INVALID" | "MANIFEST_INVALID",
): Uint8Array {
  try {
    const path = join(directory, name);
    assertNoLevelDbLinks(path);
    const descriptor = openSync(path, "r");
    try {
      const before = fstatSync(descriptor);
      if (!before.isFile() || before.size > limit)
        throw new Error("metadata is not a regular file or exceeds permitted bytes");
      const bytes = new Uint8Array(before.size);
      let position = 0;
      while (position < bytes.length) {
        const count = readSync(descriptor, bytes, position, bytes.length - position, position);
        if (count === 0) throw new Error("short metadata read");
        position += count;
      }
      const after = fstatSync(descriptor);
      if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new LevelDbSnapshotError("SOURCE_CHANGED", name, "metadata changed during reading");
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  } catch (cause) {
    if (cause instanceof LevelDbSnapshotError) throw cause;
    throw new LevelDbSnapshotError(code, name, errorMessage(cause), cause);
  }
}
