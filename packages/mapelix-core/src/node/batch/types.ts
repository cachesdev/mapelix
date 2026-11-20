import type { SurfaceProfile } from "../../surface-profiles.js";
import type { Dimension, MapAppearance, SurfaceStoreStats, TileCoordinates } from "../../types.js";

export interface BatchBounds {
  readonly minX: number;
  readonly minZ: number;
  /** Exclusive block bounds; intersecting tiles are exported in full. */
  readonly maxX: number;
  readonly maxZ: number;
}

export interface BatchLimits {
  readonly workers: number;
  /** Accepted render jobs, including running jobs and completed tiles being written. */
  readonly maxPending: number;
  readonly maxTiles: number;
  /** New PNGs (including temporary overview sources) and both manifests. */
  readonly maxOutputBytes: number;
  readonly maxInputFileBytes: number;
  readonly timeoutMs: number;
  /** Sampled process-wide RSS, including the coordinator and tile workers. */
  readonly memoryBudgetMiB: number;
}

export interface BatchOptions {
  /** An extracted, stable Bedrock snapshot; it is only opened for reading. */
  readonly world: string;
  readonly output: string;
  readonly dimensions?: readonly (Dimension | "end")[];
  readonly zooms?: readonly number[];
  readonly topY?: number;
  readonly appearance?: MapAppearance;
  readonly shadows?: "opacity" | "off";
  readonly biomeBlendRadius?: number;
  readonly correctReferenceBugs?: boolean;
  readonly bounds?: BatchBounds;
  /**
   * Reuse unchanged tiles of the published generation when it used the same renderer and
   * settings; only tiles whose dependencies changed are rendered. Falls back to a full render.
   */
  readonly incremental?: boolean;
  /**
   * Keep extracted chunk surfaces in `<output>/.mapelix-surface-cache` between exports, keyed by
   * chunk fingerprint, renderer revision and settings, so updates only extract changed chunks.
   * `true` uses a 512 MiB bound. Removing or damaging the cache never changes the output.
   */
  readonly surfaceCache?: boolean | { readonly maxMiB?: number };
  readonly limits?: Partial<BatchLimits>;
  readonly signal?: AbortSignal;
}

export interface NormalizedBatch {
  readonly world: string;
  readonly output: string;
  readonly profiles: readonly SurfaceProfile[];
  readonly zooms: readonly number[];
  readonly appearance: MapAppearance;
  readonly shadows: "opacity" | "off";
  readonly biomeBlendRadius: number;
  readonly correctReferenceBugs: boolean;
  readonly bounds: BatchBounds | null;
  readonly incremental: boolean;
  /** Surface cache size bound in MiB; 0 disables the cache. */
  readonly surfaceCacheMiB: number;
  readonly limits: BatchLimits;
}

export interface FileIdentity {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BatchTile extends TileCoordinates, FileIdentity {}

export interface BatchManifest {
  readonly format: "mapelix-2d";
  readonly schemaVersion: 1;
  readonly complete: true;
  readonly renderer: {
    readonly name: "@mapelix/core";
    readonly version: "0.0.0";
    /** SHA-256 of compiled 2D code and the PNG runtime; independent of Git availability. */
    readonly revision: string;
  };
  readonly resources: { readonly appearanceSha256: string };
  readonly source: { readonly revision: string; readonly files: readonly FileIdentity[] };
  readonly grid: {
    readonly scheme: "xyz";
    readonly tileSize: 256;
    readonly xAxis: "east";
    readonly yAxis: "south";
    readonly pixelsPerBlock: "2^zoom";
    readonly zooms: readonly number[];
    readonly overview?: { readonly sourceZoom: 0; readonly filter: "area-premultiplied-srgb-v1" };
  };
  readonly render: {
    readonly profiles: readonly SurfaceProfile[];
    readonly appearance: MapAppearance;
    readonly shadows: "opacity" | "off";
    readonly biomeBlendRadius: number;
    readonly correctReferenceBugs: boolean;
    readonly bounds: BatchBounds | null;
  };
  readonly tileCount: number;
  readonly pngBytes: number;
  readonly tiles: readonly BatchTile[];
  /** Per-chunk source fingerprints used to update the next generation incrementally. */
  readonly sourceChunks?: FileIdentity;
  /** Present for overview exports; temporary sources are not published inventory entries. */
  readonly work?: {
    readonly tileJobs: number;
    readonly temporaryTiles: number;
    readonly temporaryPngBytes: number;
  };
}

export interface PublishedBatchManifest extends BatchManifest {
  /** Hash of the immutable generation manifest, excluding this publication pointer. */
  readonly generation: string;
  readonly tileBase: string;
}

/** How a generation was produced; reported to the caller, not stored in the manifest. */
export interface BatchUpdate {
  readonly mode: "full" | "incremental";
  /** Why a requested incremental update rendered everything. */
  readonly reason?: string;
  readonly previousGeneration?: string;
  readonly changedChunks: number;
  readonly renderedTiles: number;
  readonly composedOverviews: number;
  readonly reusedTiles: number;
  /** Disk surface cache counters when the cache is enabled. */
  readonly surfaceCache?: SurfaceStoreStats;
}

export interface BatchResult {
  readonly manifest: PublishedBatchManifest;
  readonly update: BatchUpdate;
  readonly manifestPath: string;
  readonly elapsedMs: number;
  readonly peakRssMiB: number;
}

export interface BatchWorkerInput {
  readonly batch: NormalizedBatch;
  readonly stage: string;
}

export interface PreparedBatch {
  readonly manifest: BatchManifest;
  readonly generation: string;
  readonly publicationBytes: number;
  readonly update: BatchUpdate;
}

export type BatchWorkerMessage =
  | { readonly type: "ready"; readonly prepared: PreparedBatch }
  | { readonly type: "error"; readonly name: string; readonly message: string };
