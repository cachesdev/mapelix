import type { RgbaColor } from "./block-style.js";

/** A surface color with an optional explicit biome-tint policy. */
export interface SurfaceBlockStyle {
  readonly color: RgbaColor;
  readonly biomeTint?: "none" | "ground" | "grass" | "foliage" | "water";
  /** Ground cover uses its support height and contributes no full-block shadow opacity. */
  readonly decorative?: boolean;
  readonly variants?: readonly SurfaceStyleVariant[];
}

export interface SurfaceStyleVariant extends Omit<SurfaceBlockStyle, "variants"> {
  readonly states: Readonly<Record<string, string | number>>;
}

/** Exact block names and plain data only, suitable for worker transport. */
export type SurfaceStyle = Readonly<Record<string, SurfaceBlockStyle>>;

export function surfaceBlockStyle(
  style: SurfaceStyle | undefined,
  name: string,
  states?: Readonly<Record<string, unknown>>,
): SurfaceBlockStyle | undefined {
  const base = style !== undefined && Object.hasOwn(style, name) ? style[name] : undefined;
  if (base?.variants === undefined || states === undefined) return base;
  const variant = base.variants.find((candidate) =>
    Object.entries(candidate.states).every(([key, value]) => states[key] === value),
  );
  const { variants: _variants, ...resolved } = base;
  return variant === undefined
    ? resolved
    : {
        ...resolved,
        color: variant.color,
        ...(variant.biomeTint === undefined ? {} : { biomeTint: variant.biomeTint }),
        ...(variant.decorative === undefined ? {} : { decorative: variant.decorative }),
      };
}
