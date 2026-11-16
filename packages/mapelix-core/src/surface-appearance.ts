import {
  defaultBlockStyle,
  type SurfaceStyle,
  type SurfaceBlockStyle,
  type SurfaceStyleVariant,
} from "@mapelix/prototype";
import {
  BEDROCK_BLOCK_COLORS,
  BEDROCK_BLOCK_IDS,
  PLANT_COLOR_RULES,
  LEGACY_APPEARANCE_BLOCKS,
  appearanceStateVariants,
  appearanceColorKind,
  canonicalBlockName,
  resolveAppearanceColors,
  rgb,
  type BlockStates,
} from "./appearance/index.js";

// These are top-view classification rules, not a second color palette.
const SMALL_COVER =
  /^(?:pink_petals|leaf_litter|wildflowers|red_shrub|resin_clump)$|(?:^|_)carpet$/;

function topViewStyle(name: string, states: BlockStates): SurfaceBlockStyle {
  const canonical = canonicalBlockName(name, states);
  const reference = defaultBlockStyle(`minecraft:${canonical}`);
  const kind = appearanceColorKind(name, states);
  const colors = resolveAppearanceColors(
    name,
    states,
    kind,
    rgb(reference.red, reference.green, reference.blue),
  );
  let top = colors.axis === "y" ? colors.top : colors.side;
  // Bush-like plants use their sampled top face; crops retain their shared tuned color.
  const sampled = BEDROCK_BLOCK_COLORS[canonical];
  const plantKind = PLANT_COLOR_RULES.find(([pattern]) => pattern.test(canonical))?.[1];
  if (kind === "plant" && plantKind === "bush" && colors.tint === "none" && sampled !== undefined) {
    const variant = sampled.variants?.find((entry) =>
      Object.entries(entry.states).every(([key, value]) => states[key] === value),
    );
    top = (variant?.colors ?? sampled.colors)[0];
  }
  return Object.freeze({
    color: Object.freeze({
      red: top >>> 16,
      green: (top >>> 8) & 255,
      blue: top & 255,
      alpha: reference.alpha,
    }),
    biomeTint: colors.tint,
    ...(kind === "plant" || kind === "flower" || SMALL_COVER.test(canonical)
      ? { decorative: true }
      : {}),
  });
}

function sameColor(left: SurfaceBlockStyle, right: SurfaceBlockStyle): boolean {
  return (
    left.color.red === right.color.red &&
    left.color.green === right.color.green &&
    left.color.blue === right.color.blue &&
    left.color.alpha === right.color.alpha &&
    left.biomeTint === right.biomeTint
  );
}

function compileStyle(name: string): SurfaceBlockStyle {
  const base = topViewStyle(name, {});
  const variants: SurfaceStyleVariant[] = [];
  for (const states of [...appearanceStateVariants(name), {}]) {
    const vertical = topViewStyle(name, states);
    for (const axis of ["x", "z"] as const) {
      const horizontal = topViewStyle(name, { ...states, pillar_axis: axis });
      if (!sameColor(vertical, horizontal))
        variants.push(Object.freeze({ states: { ...states, pillar_axis: axis }, ...horizontal }));
    }
    if (Object.keys(states).length) variants.push(Object.freeze({ states, ...vertical }));
  }
  return Object.freeze({
    ...base,
    ...(variants.length ? { variants: Object.freeze(variants) } : {}),
  });
}

/** One declarative view of the shared 3D catalog; no independently maintained RGB values. */
export const MODERN_SURFACE_STYLE: SurfaceStyle = Object.freeze(
  Object.fromEntries(
    [...new Set([...BEDROCK_BLOCK_IDS, ...LEGACY_APPEARANCE_BLOCKS])].map((name) => [
      `minecraft:${name}`,
      compileStyle(name),
    ]),
  ),
);
