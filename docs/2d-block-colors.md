# Shared colors and classic 2D appearance

`@mapelix/core` defaults to `appearance: "modern"`. Both the 2D adapter and the 3D scene
renderer now consume `@mapelix/core/appearance`. There is no separately maintained 2D RGB table.
`appearance: "reference"` retains the previous 2D colors and decorative classification while
keeping dimension profiles, fixed Data3D slots and included top-Y cuts.

## Single shared source

The portable appearance entry owns:

- The existing 1,276 sampled block palettes and their conditional state variants.
- All 1,466 identifiers from the supplied Bedrock registry, including entries without a sample.
- The established tuned foliage, flower, wood, ground and material color decisions.
- Canonical legacy names, color-state cases and axis-dependent face colors.

The generated data is in `packages/mapelix-core/src/appearance/bedrock-colors.ts`; the shared
resolver is in `block-colors.ts` beside it. The original scene import path re-exports the same
catalog object. The scene adapter still owns shapes, models, geometry, materials and lighting.
It calls the shared resolver with its existing shape category and fallback color.

The catalog is regenerated from the existing official samples `1.26.60.5`, using the unchanged
numeric color inputs and bindings described in [the palette documentation](block-colors.md).
Only the complete registry identifier list was added to the generated metadata. No texture assets
or external runtime dependencies were added. The scene package gains a dependency on the existing
core workspace; core depends on the reference package, with no dependency cycle.
Consumers caching color-dependent output should include the shared appearance entry in their
renderer fingerprint. The pure extraction preserves existing 3D output and format revisions.

Biome definitions were already shared through `legacyBiomeStyle` in `@mapelix/prototype`.
Both renderers keep that source, including the bamboo, pale-garden, sulfur-cave and dappled-forest
profiles, legacy aliases and explicit ice-cave family fallback. The 2D code does not copy the
3D grass/foliage brightness gains: those compensate for 3D face lighting.

## What remains specific to the 2D view

| Rule                                   | Reason                                                                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Upward-facing color                    | A horizontal log exposes its side color when viewed from above; the shared axis and face values determine that choice.                                                                                 |
| Untinted bush-like plants              | Use the sampled top-face mean instead of a generic bush/sprite color. Crops retain the shared tuned color rather than a texture's initial growth stage. RGB values still come from the common catalog. |
| Ground-cover support                   | Plants, petals, litter, small shrubs and carpets should not introduce a whole-block contour or full-block shadow. Their visible name/Y remains available; relief uses the support height.              |
| Transparency and water depth           | Keep classic 2D glass alpha, water-depth compositing and opacity-run shadows. A flat raster does not use the 3D material shader or refraction.                                                         |
| Elevation, contours and biome blending | Preserve map readability and the reference renderer's height/lightness curves. The 3D renderer applies its own face lighting and optional neighborhood tints.                                          |

The 2D profile is derived from the shared registry/resolver and serialized for worker jobs. Palette
states are resolved once per decoded subchunk palette entry. A voxel's diagnostic style contains
only its selected color/tint/cover metadata, not the complete variant list. Differently dyed glass
layers retain distinct colors even when their legacy block name is the same. Fixed poplar/pale-oak
foliage stays fixed; ordinary foliage and grass retain their explicit biome tint.

Only exact vanilla identifiers receive generated profiles. Similarly named add-on blocks retain
the existing fallback behavior. An explicit `resolveBlockStyle` callback takes precedence over
catalog colors. Range/style-only requests remain eligible for workers; generic scheduling of
other options remains separate work. Both the profile root and appearance entry import without
Node builtins; snapshot access remains in `@mapelix/core/node`.

## Boundaries that are not shared rendering features

The 2D adapter reads terrain palette states. It does not read optional block-entity records to
recover real Bedrock bed dyes yet. The shared palette contains all 16 bed dyes and the 2D API
uses them when a caller supplies the color state; a snapshot bed without that state keeps its
default color. This is a reader/metadata gap, not a second color table.

3D shapes, partial face coverage, ambient occlusion, LOD meshing, transparent-water optics and
animated effects stay in the scene engine. The classic 2D renderer still does not rasterize those
models or resource-pack textures. Waterlogging overlays are not added. Missing resource bindings
and technical/Education entries retain explicit shared rule or fallback behavior rather than
invented sampled colors. A shared catalog does not imply identical pixels between a flat map
and a lit 3D scene, or parity with a different uNmINeD style/version.

## Validation

Tests cover state/axis-dependent colors, legacy aliases, modern biome ground colors, translucent
layers, cover support, exact cuts, negative seams, worker transport and reference-profile parity.
The original scene import is checked to reference the same catalog object. The pre-extraction
reference comprises 4,461 appearance cases across the full registry, variants and axes, plus six
region payloads across the three dimensions. Review evidence checks these unchanged after the
sharing change, alongside fresh real-snapshot comparisons. Worlds, captures and raw measurements
remain under ignored `.local/` storage.
