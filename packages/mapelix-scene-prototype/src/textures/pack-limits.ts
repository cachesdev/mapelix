/** Bounds on what reading one resource pack may cost. Every pack in a stack gets its own. */
export interface PackLimits {
  /** Size of a zip or `.mcpack` file. */
  readonly maxArchiveBytes: number;
  /** Files (and, in an archive, directory entries) in one pack. */
  readonly maxEntries: number;
  /** Sum of the uncompressed sizes of every file in one pack. */
  readonly maxTotalBytes: number;
  /** Uncompressed size of one file that is read. */
  readonly maxFileBytes: number;
  /**
   * Largest uncompressed-to-compressed size ratio of an archive entry above
   * `RATIO_FLOOR_BYTES`. Sparse vanilla textures reach about 120 to 1; a zip bomb nears
   * the deflate limit of about 1000 to 1.
   */
  readonly maxCompressionRatio: number;
  /** Pixels of one decoded image. */
  readonly maxImagePixels: number;
  /** Width or height of one decoded image. */
  readonly maxImageSide: number;
}

export const DEFAULT_PACK_LIMITS: PackLimits = {
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxEntries: 65_536,
  maxTotalBytes: 2048 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 400,
  maxImagePixels: 4 * 1024 * 1024,
  maxImageSide: 8192,
};

/** Entries smaller than this are too small for their ratio to matter. */
export const RATIO_FLOOR_BYTES = 1024 * 1024;

/** A pack that cannot be used, named with the pack and, when known, the file inside it. */
export class ResourcePackError extends Error {
  readonly pack: string;
  readonly file: string | undefined;

  constructor(pack: string, message: string, file?: string) {
    super(`Resource pack ${pack}${file === undefined ? "" : ` (${file})`}: ${message}`);
    this.name = "ResourcePackError";
    this.pack = pack;
    this.file = file;
  }
}

export function packLimits(overrides: Partial<PackLimits> = {}): PackLimits {
  const limits = { ...DEFAULT_PACK_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`Pack limit ${name} must be a positive integer, received ${value}`);
    }
  }
  return limits;
}

/**
 * Normalizes a path inside a pack to `a/b/c`, refusing anything that could leave the pack:
 * absolute paths, drive letters, backslashes, `.` or `..` segments, empty segments and NUL.
 * Returns undefined for a directory entry (trailing slash).
 */
export function packPath(raw: string): string | undefined {
  if (raw.length === 0 || raw.length > 1024) throw new Error("path is empty or too long");
  if (raw.includes("\0") || raw.includes("\\")) throw new Error("path holds a NUL or a backslash");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) throw new Error("path is absolute");
  const directory = raw.endsWith("/");
  const segments = (directory ? raw.slice(0, -1) : raw).split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new Error("path has an empty, . or .. segment");
    }
  }
  return directory ? undefined : segments.join("/");
}
