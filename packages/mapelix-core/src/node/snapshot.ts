import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { inflateRawSync, inflateSync } from "node:zlib";
import {
  LevelDbBlockLimitError,
  readSnappyBlock,
  validateLevelDbTable,
  verifyTableBlockTrailer,
  visitLevelDbRecords,
} from "@mapelix/prototype/bedrock";
import {
  LevelDbSnapshotError,
  openLevelDbSnapshot,
  readLevelDbSnapshotFile,
  levelDbFileError,
  type LevelDbSnapshotErrorCode,
} from "@mapelix/prototype/node/leveldb";

import { identifyFile, jsonBytes, sha256, sourceIdentity } from "./snapshot-identity.js";
import type { FileIdentity } from "./batch/types.js";

export const SNAPSHOT_VALIDATION_VERSION = 1;
export const SNAPSHOT_VALIDATION_FORMAT = "mapelix-snapshot-validation";

export interface SnapshotValidationOptions {
  readonly maxInputFileBytes?: number;
  readonly maxDecodedBlockBytes?: number;
  readonly maxTotalInputBytes?: number;
  /** Cooperative deadline; hosts may enforce a hard process limit. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export type SnapshotValidationErrorCode =
  | LevelDbSnapshotErrorCode
  | "VALIDATION_CANCELLED"
  | "VALIDATION_TIMEOUT"
  | "VALIDATION_OPTIONS_INVALID";

export interface SnapshotValidationIssue {
  readonly code: SnapshotValidationErrorCode;
  readonly file: string | null;
  readonly message: string;
}

export interface SnapshotValidationResult {
  readonly format: typeof SNAPSHOT_VALIDATION_FORMAT;
  readonly schemaVersion: typeof SNAPSHOT_VALIDATION_VERSION;
  readonly valid: boolean;
  /** Content revision shared with 2D exports; null unless every check succeeded. */
  readonly revision: string | null;
  /** Counts are null when the common selection could not be established. */
  readonly activeTables: number | null;
  readonly selectedJournals: number | null;
  readonly ignoredTables: number | null;
  /** Completed files/logical bytes; excludes the final consistency re-read. */
  readonly filesChecked: number;
  readonly bytesChecked: number;
  readonly elapsedMs: number;
  /** Fail-fast validation: empty on success, exactly one issue on failure. */
  readonly errors: readonly SnapshotValidationIssue[];
}

class StoppedValidation extends Error {
  readonly code: "VALIDATION_CANCELLED" | "VALIDATION_TIMEOUT";
  constructor(code: "VALIDATION_CANCELLED" | "VALIDATION_TIMEOUT") {
    super(
      code === "VALIDATION_CANCELLED"
        ? "Snapshot validation cancelled"
        : "Snapshot validation deadline exceeded",
    );
    this.code = code;
  }
}

function positive(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** Exhaustively validates the selected LevelDB state without rendering or writing anything. */
export async function validateSnapshot(
  directory: string,
  options: SnapshotValidationOptions = {},
): Promise<SnapshotValidationResult> {
  if (typeof directory !== "string" || directory.length === 0)
    throw new TypeError("directory must be a nonempty string");
  if (typeof options !== "object" || options === null)
    throw new TypeError("options must be an object");
  const maxFile = positive("maxInputFileBytes", options.maxInputFileBytes ?? 256 * 1024 * 1024);
  const maxBlock = positive(
    "maxDecodedBlockBytes",
    options.maxDecodedBlockBytes ?? 16 * 1024 * 1024,
  );
  const maxTotal = positive(
    "maxTotalInputBytes",
    options.maxTotalInputBytes ?? 32 * 1024 * 1024 * 1024,
  );
  const timeoutMs = positive("timeoutMs", options.timeoutMs ?? 300000);
  if (timeoutMs > 2147483647) throw new RangeError("timeoutMs must be at most 2147483647");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    throw new TypeError("signal must be an AbortSignal");
  const started = performance.now();
  const controller = new AbortController();
  let stopped: StoppedValidation | undefined;
  const stop = (code: "VALIDATION_CANCELLED" | "VALIDATION_TIMEOUT") => {
    stopped ??= new StoppedValidation(code);
    controller.abort(stopped);
  };
  const cancelled = () => stop("VALIDATION_CANCELLED");
  const timer = setTimeout(() => stop("VALIDATION_TIMEOUT"), timeoutMs);
  timer.unref();
  options.signal?.addEventListener("abort", cancelled, { once: true });
  if (options.signal?.aborted) cancelled();
  const check = () => {
    if (!controller.signal.aborted && performance.now() - started >= timeoutMs)
      stop("VALIDATION_TIMEOUT");
    controller.signal.throwIfAborted();
  };
  let activeTables: number | null = null;
  let selectedJournals: number | null = null;
  let ignoredTables: number | null = null;
  let filesChecked = 0;
  let bytesChecked = 0;
  let currentFile: string | null = null;
  const result = (
    valid: boolean,
    revision: string | null,
    errors: readonly SnapshotValidationIssue[],
  ): SnapshotValidationResult => ({
    format: SNAPSHOT_VALIDATION_FORMAT,
    schemaVersion: SNAPSHOT_VALIDATION_VERSION,
    valid,
    revision,
    activeTables,
    selectedJournals,
    ignoredTables,
    filesChecked,
    bytesChecked,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    errors,
  });
  const limit = (bytes: number) => {
    if (bytes > maxFile || bytesChecked + bytes > maxTotal)
      throw new LevelDbSnapshotError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        currentFile ?? "db",
        "snapshot exceeds configured input bytes",
      );
  };
  try {
    check();
    const snapshot = openLevelDbSnapshot(directory, {
      maxFileBytes: maxFile,
      signal: controller.signal,
    });
    check();
    activeTables = snapshot.tables.length;
    selectedJournals = snapshot.logs.length;
    ignoredTables = snapshot.ignoredTables.length;
    const selectedBytes =
      snapshot.currentBytes.length +
      snapshot.manifestBytes.length +
      snapshot.files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(selectedBytes) || selectedBytes > maxTotal)
      throw new LevelDbSnapshotError(
        "SNAPSHOT_LIMIT_EXCEEDED",
        "db",
        "selected files exceed configured total input bytes",
      );
    const files: FileIdentity[] = [];
    for (const [name, bytes] of [
      ["CURRENT", snapshot.currentBytes],
      [snapshot.manifestName, snapshot.manifestBytes],
    ] as const) {
      currentFile = `db/${name}`;
      limit(bytes.length);
      files.push({ path: currentFile, bytes: bytes.length, sha256: sha256(bytes) });
      filesChecked++;
      bytesChecked += bytes.length;
    }
    const database = join(directory, "db");
    const metadata = new Map(snapshot.tables.map((table) => [table.name, table]));
    for (const file of snapshot.files) {
      check();
      currentFile = `db/${file.name}`;
      limit(file.size);
      const bytes = await readLevelDbSnapshotFile(database, file, controller.signal);
      try {
        if (file.kind === "table") {
          const blocks = validateLevelDbTable(
            bytes,
            metadata.get(file.name)!,
            file.name,
            (encoded, source, filter) => decodeValidationBlock(encoded, source, maxBlock, filter),
          );
          while (true) {
            check();
            if (blocks.next().done) break;
            await setImmediate();
          }
        } else visitLevelDbRecords({ name: file.name, bytes }, check, { verifyChecksums: true });
      } catch (cause) {
        check();
        if (cause instanceof LevelDbBlockLimitError)
          throw new LevelDbSnapshotError(
            "SNAPSHOT_LIMIT_EXCEEDED",
            file.name,
            cause.message,
            cause,
          );
        throw levelDbFileError(file, cause);
      }
      files.push({ path: currentFile, bytes: bytes.length, sha256: sha256(bytes) });
      filesChecked++;
      bytesChecked += bytes.length;
      await setImmediate();
    }
    currentFile = "level.dat";
    const level = await lstat(join(directory, "level.dat")).catch((cause: unknown) => {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
      throw cause;
    });
    if (level !== undefined) {
      limit(level.size);
      files.push(
        await identifyFile(join(directory, "level.dat"), "level.dat", maxFile, controller.signal),
      );
      filesChecked++;
      bytesChecked += level.size;
    }
    check();
    currentFile = "db";
    const verified = await sourceIdentity(directory, maxFile, controller.signal);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (jsonBytes(files) !== jsonBytes(verified.files))
      throw new LevelDbSnapshotError(
        "SOURCE_CHANGED",
        "db",
        "selected source contents changed during validation",
      );
    check();
    return result(true, verified.revision, []);
  } catch (cause) {
    const failure = controller.signal.aborted ? stopped : cause;
    const code =
      failure instanceof StoppedValidation || failure instanceof LevelDbSnapshotError
        ? failure.code
        : "SNAPSHOT_IO_ERROR";
    const rawFile = failure instanceof LevelDbSnapshotError ? failure.file : currentFile;
    const file =
      rawFile === null || rawFile === "db" || rawFile === "level.dat" || rawFile.startsWith("db/")
        ? rawFile
        : `db/${rawFile}`;
    return result(false, null, [
      { code, file, message: failure instanceof Error ? failure.message : String(failure) },
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancelled);
  }
}

function decodeValidationBlock(
  encoded: Uint8Array,
  source: string,
  maxBytes: number,
  filter: boolean,
): Uint8Array {
  verifyTableBlockTrailer(encoded, source);
  const compression = encoded[encoded.length - 5]!;
  const raw = encoded.subarray(0, encoded.length - 5);
  if (compression === 1) return readSnappyBlock(raw, source, maxBytes);
  // Preserve the reader's wrapper compatibility, while bounding native inflation.
  if (compression !== 0 || !filter) {
    for (const inflate of compression === 2
      ? [inflateSync, inflateRawSync]
      : [inflateRawSync, inflateSync]) {
      try {
        const decoded = inflate(raw, { maxOutputLength: maxBytes });
        if (compression !== 0 || looksLikeEntryBlock(decoded)) return decoded;
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ERR_BUFFER_TOO_LARGE")
          throw new LevelDbBlockLimitError(
            `${source}: decoded block exceeds permitted bytes (${maxBytes})`,
          );
      }
    }
  }
  if (raw.length > maxBytes)
    throw new LevelDbBlockLimitError(`${source}: block exceeds permitted bytes (${maxBytes})`);
  return raw;
}

function looksLikeEntryBlock(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  const count = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(
    0,
    true,
  );
  return count <= (bytes.length - 4) / 4;
}
