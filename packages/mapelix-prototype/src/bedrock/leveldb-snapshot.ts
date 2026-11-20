import { levelDbLogRecords } from "./leveldb-log.js";
import { parseInternalKey } from "./record-source.js";
import { compareInternalKeys } from "./table-validation.js";

export type LevelDbSnapshotErrorCode =
  | "CURRENT_INVALID"
  | "MANIFEST_INVALID"
  | "MANIFEST_UNSUPPORTED"
  | "ACTIVE_FILE_MISSING"
  | "ACTIVE_TABLE_INVALID"
  | "REQUIRED_LOG_INVALID"
  | "SNAPSHOT_IO_ERROR"
  | "SNAPSHOT_LIMIT_EXCEEDED"
  | "SOURCE_CHANGED";

/** Stable error details shared by readers and snapshot validation. */
export class LevelDbSnapshotError extends Error {
  readonly code: LevelDbSnapshotErrorCode;
  readonly file: string;

  constructor(code: LevelDbSnapshotErrorCode, file: string, message: string, cause?: unknown) {
    super(`${file}: ${message}`, { cause });
    this.name = "LevelDbSnapshotError";
    this.code = code;
    this.file = file;
  }
}

export interface LevelDbTableMetadata {
  readonly number: bigint;
  readonly level: number;
  /** Logical table length from the manifest, including its footer. */
  readonly size: number;
  readonly smallest: Uint8Array;
  readonly largest: Uint8Array;
}

export interface LevelDbManifest {
  readonly tables: readonly LevelDbTableMetadata[];
  readonly logNumber: bigint;
  readonly previousLogNumber: bigint;
  readonly nextFileNumber: bigint;
  readonly lastSequence: bigint;
}

export interface SelectedLevelDbFile {
  readonly name: string;
  readonly number: bigint;
  readonly kind: "table" | "log";
}

export interface SelectedLevelDbTable extends SelectedLevelDbFile, LevelDbTableMetadata {
  readonly kind: "table";
}

export interface LevelDbFileSelection {
  readonly tables: readonly SelectedLevelDbTable[];
  readonly logs: readonly (SelectedLevelDbFile & { readonly kind: "log" })[];
  readonly ignoredTables: readonly string[];
}

/** CURRENT contains exactly one relative manifest basename and a final newline. */
export function readLevelDbCurrent(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  if (!/^MANIFEST-[0-9]+\n$/.test(text))
    throw new LevelDbSnapshotError(
      "CURRENT_INVALID",
      "CURRENT",
      "expected a manifest basename followed by a newline",
    );
  return text.slice(0, -1);
}

class Cursor {
  position = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  integer(): bigint {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = this.bytes[this.position++];
      if (byte === undefined || (shift === 63n && byte > 1))
        throw new Error("invalid manifest varint64");
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) return value;
    }
    throw new Error("invalid manifest varint64");
  }
  safeInteger(): number {
    const value = this.integer();
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("manifest integer exceeds supported range");
    return Number(value);
  }
  level(): number {
    const level = this.safeInteger();
    if (level > 6) throw new Error("invalid manifest table level");
    return level;
  }
  string(): Uint8Array {
    const length = this.safeInteger();
    if (length > this.bytes.length - this.position) throw new Error("truncated manifest string");
    const result = this.bytes.slice(this.position, this.position + length);
    this.position += length;
    return result;
  }
  key(): Uint8Array {
    const key = this.string();
    parseInternalKey(key, "manifest");
    return key;
  }
}

/** Replays VersionEdits, applying each edit's removals before its additions. */
export function readLevelDbManifest(bytes: Uint8Array, source: string): LevelDbManifest {
  const tables = new Map<string, LevelDbTableMetadata>();
  let logNumber: bigint | undefined;
  let nextFileNumber: bigint | undefined;
  let lastSequence: bigint | undefined;
  let previousLogNumber = 0n;
  try {
    for (const record of levelDbLogRecords(bytes, source)) {
      const cursor = new Cursor(record);
      const removed: string[] = [];
      const added: LevelDbTableMetadata[] = [];
      while (cursor.position < record.length) {
        const tag = cursor.safeInteger();
        switch (tag) {
          case 1: {
            const comparator = new TextDecoder().decode(cursor.string());
            if (comparator !== "leveldb.BytewiseComparator")
              throw new LevelDbSnapshotError(
                "MANIFEST_UNSUPPORTED",
                source,
                `unsupported comparator ${comparator}`,
              );
            break;
          }
          case 2:
            logNumber = cursor.integer();
            break;
          case 3:
            nextFileNumber = cursor.integer();
            break;
          case 4:
            lastSequence = cursor.integer();
            if (lastSequence > (1n << 56n) - 1n) throw new Error("invalid manifest sequence");
            break;
          case 5:
            cursor.level();
            cursor.key();
            break;
          case 6:
            removed.push(`${cursor.level()}:${cursor.integer()}`);
            break;
          case 7: {
            const level = cursor.level();
            const number = cursor.integer();
            const size = cursor.safeInteger();
            const smallest = cursor.key();
            const largest = cursor.key();
            if (number === 0n || size < 48) throw new Error("invalid manifest table metadata");
            if (compareInternalKeys(smallest, largest) > 0)
              throw new Error("reversed manifest table key range");
            added.push({ level, number, size, smallest, largest });
            break;
          }
          case 9:
            previousLogNumber = cursor.integer();
            break;
          default:
            throw new LevelDbSnapshotError(
              "MANIFEST_UNSUPPORTED",
              source,
              `unsupported VersionEdit tag ${tag}`,
            );
        }
      }
      for (const id of removed) tables.delete(id);
      for (const table of added) tables.set(`${table.level}:${table.number}`, table);
    }
    if (logNumber === undefined || nextFileNumber === undefined || lastSequence === undefined)
      throw new Error("manifest is missing LogNumber, NextFileNumber or LastSequence");
    const active = [...tables.values()].sort((a, b) => compareNumbers(a.number, b.number));
    if (new Set(active.map((table) => table.number)).size !== active.length)
      throw new Error("one active table appears at multiple levels");
    return { tables: active, logNumber, previousLogNumber, nextFileNumber, lastSequence };
  } catch (cause) {
    if (cause instanceof LevelDbSnapshotError) throw cause;
    throw new LevelDbSnapshotError("MANIFEST_INVALID", source, errorMessage(cause), cause);
  }
}

/** Selects only live tables and recoverable WALs; never inspects inactive contents. */
export function selectLevelDbFiles(
  manifest: LevelDbManifest,
  names: readonly string[],
): LevelDbFileSelection {
  const available = new Set(names);
  const tables = manifest.tables.map((table): SelectedLevelDbTable => {
    const stem = table.number.toString().padStart(6, "0");
    const name = available.has(`${stem}.ldb`) ? `${stem}.ldb` : `${stem}.sst`;
    if (!available.has(name))
      throw new LevelDbSnapshotError(
        "ACTIVE_FILE_MISSING",
        `${stem}.ldb`,
        "active table is missing",
      );
    return { ...table, name, kind: "table" };
  });
  const logs = names
    .flatMap((name): (SelectedLevelDbFile & { kind: "log" })[] => {
      const match = /^([0-9]+)\.log$/.exec(name);
      if (match === null) return [];
      const number = BigInt(match[1]!);
      return number >= manifest.logNumber ||
        (manifest.previousLogNumber !== 0n && number === manifest.previousLogNumber)
        ? [{ name, number, kind: "log" }]
        : [];
    })
    .sort((a, b) => compareNumbers(a.number, b.number));
  const selected = new Set(tables.map((table) => table.name));
  return {
    tables,
    logs,
    ignoredTables: names.filter((name) => /\.(ldb|sst)$/.test(name) && !selected.has(name)).sort(),
  };
}

function compareNumbers(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
