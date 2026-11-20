/** Vanilla Bedrock dimensions. This module is safe to import in the browser. */
export type Dimension = "overworld" | "nether" | "the-end";
export type GeometryMode = "surface" | "interior" | "islands";

export interface DimensionConfig {
  readonly dimension: Dimension;
  readonly label: string;
  readonly storageId: number;
  readonly minY: number;
  /** Exclusive upper block bound. */
  readonly maxY: number;
  readonly geometry: GeometryMode;
  /** Exclusive mesh ceiling, applied before face culling and LOD reduction. */
  readonly defaultCeilingY: number;
  readonly atmosphere: {
    readonly zenith: number;
    readonly horizon: number;
    readonly light: number;
    readonly ground: number;
    readonly ambient: number;
    readonly hazeDistance: number;
  };
}

export const DIMENSIONS: Readonly<Record<Dimension, DimensionConfig>> = {
  overworld: {
    dimension: "overworld",
    label: "Overworld",
    storageId: 0,
    minY: -64,
    maxY: 320,
    geometry: "surface",
    defaultCeilingY: 320,
    atmosphere: {
      zenith: 0x3d7ad8,
      horizon: 0xb9d3ec,
      light: 0xfff1dc,
      ground: 0x8a7a62,
      ambient: 0.9,
      hazeDistance: 2400,
    },
  },
  nether: {
    dimension: "nether",
    label: "Nether",
    storageId: 1,
    minY: 0,
    maxY: 128,
    geometry: "interior",
    defaultCeilingY: 96,
    atmosphere: {
      zenith: 0x240909,
      horizon: 0x63201a,
      light: 0xffb6a0,
      ground: 0x89544a,
      ambient: 0.65,
      hazeDistance: 700,
    },
  },
  "the-end": {
    dimension: "the-end",
    label: "The End",
    storageId: 2,
    minY: 0,
    maxY: 256,
    geometry: "islands",
    defaultCeilingY: 256,
    atmosphere: {
      zenith: 0x080610,
      horizon: 0x20152f,
      light: 0xc6b5df,
      ground: 0x6c5d80,
      ambient: 0.7,
      hazeDistance: 3200,
    },
  },
};

export type ViewMode = "surface" | "caves";

export interface VerticalBounds {
  readonly minY: number;
  /** Exclusive upper block bound. */
  readonly maxY: number;
}

/** Initial cave capabilities; adapters may impose smaller streaming/cache budgets. */
export const CAVE_LIMITS = {
  thicknesses: [16, 32] as readonly number[],
  defaultThickness: 32,
  maxLevel: 1,
  viewDistance: 128,
  memoryBudget: 32 * 1024 * 1024,
} as const;

export interface SceneContextOptions {
  readonly mode?: ViewMode;
  readonly minY?: number;
  readonly maxY?: number;
  /** Legacy alias for the exclusive maxY. Equal aliases are accepted. */
  readonly ceilingY?: number;
}

/** Accepts legacy dimension/ceiling metadata as well as the canonical context. */
export interface SceneContextInput extends SceneContextOptions {
  readonly dimension: Dimension;
}

export interface SceneContext extends VerticalBounds {
  readonly dimension: Dimension;
  readonly mode: ViewMode;
  readonly ceilingY: number;
}

export function parseDimension(value: unknown): Dimension {
  if (value === undefined || value === null) return "overworld";
  if (value === "overworld" || value === "nether" || value === "the-end") return value;
  throw new RangeError(
    `Unsupported dimension: ${typeof value === "string" ? value : "invalid value"}`,
  );
}

/** Ceilings align to 16 blocks so every LOD has the same exact cut boundary. */
export function sceneContext(
  dimension: Dimension = "overworld",
  options: number | SceneContextOptions = {},
): SceneContext {
  const config = DIMENSIONS[parseDimension(dimension)];
  const input = typeof options === "number" ? { ceilingY: options } : options;
  const mode = input.mode ?? "surface";
  if (mode !== "surface" && mode !== "caves") throw new RangeError("Unsupported view mode");
  if (input.maxY !== undefined && input.ceilingY !== undefined && input.maxY !== input.ceilingY) {
    throw new RangeError("maxY and ceilingY must agree");
  }
  const upper = input.maxY ?? input.ceilingY;
  const minY =
    input.minY ??
    (mode === "caves" && upper !== undefined ? upper - CAVE_LIMITS.defaultThickness : config.minY);
  const maxY =
    upper ?? (mode === "caves" ? minY + CAVE_LIMITS.defaultThickness : config.defaultCeilingY);
  if (
    !Number.isSafeInteger(minY) ||
    !Number.isSafeInteger(maxY) ||
    minY % 16 !== 0 ||
    maxY % 16 !== 0 ||
    minY < config.minY ||
    maxY > config.maxY ||
    minY >= maxY
  ) {
    throw new RangeError(`Vertical bounds must align to 16 within ${config.minY}..${config.maxY}`);
  }
  if (mode === "surface" && minY !== config.minY)
    throw new RangeError("A raised minY requires caves mode");
  if (mode === "caves" && !CAVE_LIMITS.thicknesses.includes(maxY - minY)) {
    throw new RangeError("Cave thickness must be 16 or 32 blocks");
  }
  return { dimension, mode, minY, maxY, ceilingY: maxY };
}

export function contextFromSearch(params: URLSearchParams): SceneContext {
  const number = (name: string): number | undefined => {
    const raw = params.get(name);
    if (raw === null) return undefined;
    return raw.trim() === "" ? NaN : Number(raw);
  };
  const mode = params.get("mode") ?? "surface";
  if (mode !== "surface" && mode !== "caves") throw new RangeError("Unsupported view mode");
  return sceneContext(parseDimension(params.get("dimension")), {
    mode,
    ...optional("minY", number("minY")),
    ...optional("maxY", number("maxY")),
    ...optional("ceilingY", number("ceilingY")),
  });
}

export function contextKey(input: SceneContextInput): string {
  const context = sceneContext(input.dimension, input);
  // Keep legacy Surface/Nether/End paths reusable; their floor is fixed by dimension.
  return context.mode === "surface"
    ? `${context.dimension}/${context.maxY}`
    : `${context.dimension}/caves/${context.minY}/${context.maxY}`;
}

export function contextSearch(input: SceneContextInput): URLSearchParams {
  const context = sceneContext(input.dimension, input);
  return new URLSearchParams(
    context.mode === "surface"
      ? { dimension: context.dimension, ceilingY: String(context.maxY) }
      : {
          dimension: context.dimension,
          mode: "caves",
          minY: String(context.minY),
          maxY: String(context.maxY),
        },
  );
}

export function regionCacheKey(
  context: SceneContextInput,
  region: { readonly level: number; readonly x: number; readonly z: number },
): string {
  return `${contextKey(context)}/${region.level}/${region.x}/${region.z}`;
}

/** Full source sections around a cut preserve natural neighbor culling at both planes. */
export function paddedBounds(bounds: VerticalBounds, dimension: Dimension): VerticalBounds {
  const config = DIMENSIONS[dimension];
  return {
    minY: Math.max(config.minY, Math.floor((bounds.minY - 1) / 16) * 16),
    maxY: Math.min(config.maxY, Math.ceil((bounds.maxY + 1) / 16) * 16),
  };
}

function optional<K extends string>(
  name: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [name]: value } as Record<K, number>);
}
