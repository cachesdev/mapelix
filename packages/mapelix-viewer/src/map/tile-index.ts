import { tileSpan, type TileAddress } from "./tile-math.js";

/** The parts of a published `mapelix-render` manifest (format `mapelix-2d`, version 1) used here. */
export interface PublishedTileManifest {
  readonly format: "mapelix-2d";
  readonly schemaVersion: 1;
  readonly generation: string;
  readonly tileBase: string;
  readonly grid: { readonly tileSize: number; readonly zooms: readonly number[] };
  readonly tiles: readonly {
    readonly dimension: string;
    readonly z: number;
    readonly x: number;
    readonly y: number;
    readonly path: string;
  }[];
}

const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

/**
 * Which tiles a pinned generation has, per dimension, and their URLs. Asking only for listed
 * tiles avoids a request for every empty square of the world.
 */
export class TileIndex {
  readonly generation: string;
  private readonly base: URL;
  private readonly paths = new Map<string, Map<string, string>>();
  private readonly levels = new Map<string, number[]>();
  private readonly extents = new Map<string, [number, number, number, number]>();

  constructor(manifest: PublishedTileManifest, manifestUrl: string | URL) {
    if (manifest.format !== "mapelix-2d" || manifest.schemaVersion !== 1)
      throw new Error("Unsupported tile manifest");
    if (manifest.grid.tileSize !== 256) throw new Error("Unsupported tile size");
    this.generation = manifest.generation;
    this.base = new URL(manifest.tileBase, manifestUrl);
    for (const tile of manifest.tiles) {
      let paths = this.paths.get(tile.dimension);
      if (paths === undefined) this.paths.set(tile.dimension, (paths = new Map()));
      paths.set(key(tile.z, tile.x, tile.y), tile.path);
      const levels = this.levels.get(tile.dimension) ?? [];
      if (!levels.includes(tile.z)) this.levels.set(tile.dimension, [...levels, tile.z]);
      // Blocks covered, from the finest tiles: [west, north, east, south].
      const span = tileSpan(tile.z);
      const extent = this.extents.get(tile.dimension);
      const west = tile.x * span,
        north = tile.y * span;
      if (extent === undefined)
        this.extents.set(tile.dimension, [west, north, west + span, north + span]);
      else {
        extent[0] = Math.min(extent[0], west);
        extent[1] = Math.min(extent[1], north);
        extent[2] = Math.max(extent[2], west + span);
        extent[3] = Math.max(extent[3], north + span);
      }
    }
    for (const levels of this.levels.values()) levels.sort((a, b) => a - b);
  }

  /** Fetches and pins the current publication. */
  static async load(manifestUrl: string | URL, init?: RequestInit): Promise<TileIndex> {
    const url = new URL(manifestUrl, globalThis.location?.href);
    const response = await fetch(url, { cache: "no-cache", ...init });
    if (!response.ok) throw new Error(`The map could not be loaded (${response.status})`);
    return new TileIndex((await response.json()) as PublishedTileManifest, url);
  }

  /** Dimensions with at least one tile. */
  get dimensions(): string[] {
    return [...this.paths.keys()];
  }

  /** Zooms with tiles in `dimension`, ascending. */
  zooms(dimension: string): readonly number[] {
    return this.levels.get(dimension) ?? [];
  }

  /** Block bounds `[west, north, east, south]` of the tiles of `dimension`. */
  extent(dimension: string): readonly [number, number, number, number] | undefined {
    return this.extents.get(dimension);
  }

  url(dimension: string, tile: TileAddress): string | undefined {
    const path = this.paths.get(dimension)?.get(key(tile.z, tile.x, tile.y));
    return path === undefined ? undefined : new URL(path, this.base).href;
  }
}
