# Amelix renderer comparison suite

**Selected:** 2026-08-17.  This is a coordinate-only, repeatable suite for
comparing Mapelix with uNmINeD across more than Forest's Town.  It intentionally
does not add private-world images to Git.

## Baseline and alignment

Use the repaired disposable world copy at
`/home/caches/Repos/.mapelix-tools/unmined-world-repair-20260817/world-classic`
as the uNmINeD oracle.  It produces lossless PNG output and is currently the
best comparison base; the recovery constraints are documented in
[unmined-world-repair.md](unmined-world-repair.md).  Do not use it as a
Minecraft world or overwrite the original backup.

At native uNmINeD `zoom=2`, a 256-pixel image covers exactly 64 by 64 Minecraft
blocks, at four pixels per block.  For Minecraft `(X, Z)`, select the tile with
`tileX = floor(X / 64)` and `tileZ = floor(Z / 64)`.  Its block bounds are
`[tileX * 64, (tileX + 1) * 64)` by `[tileZ * 64, (tileZ + 1) * 64)`.  In
particular, mathematical `floor` is required for negative coordinates.  This
is both the published viewer's tile scheme and Mapelix's tile contract.

The published Amelix updater fixes its relevant output settings to zoom range
`-6..2`, `--shadows 3do`, no grid, and background `#78a7ff`; retain those
settings for the oracle renders.  Sources: [published viewer
client](https://forestoflight.github.io/AmelixSMPViewer/unmined.js), [pinned
Amelix updater](https://github.com/ForestOfLight/AmelixSMPViewer/blob/80763d20d7ff182a9f4c9a4ca64f38023ab2341c/UpdateSMPViewer.py), and
[uNmINeD CLI area semantics](https://unmined.net/2021/02/19/unmined-0-14-1-optimization/).

## Selected tiles

All seven candidates were visually verified by native-detail, lossless
uNmINeD renders from the recovered copy.  Tile `y` is Minecraft Z, not height.
Bounds have an inclusive lower edge and exclusive upper edge.

| ID | Native tile `(z=2, x, y)` | Block bounds `(X, Z)` | Scene and comparison purpose |
| --- | --- | --- | --- |
| `village-roofs` | `(-32, -49)` | `[-2048, -1984)`, `[-3136, -3072)` | Forest's Town: small house bodies, large roof overhangs, paths, trees, and several roof materials. Primary cast-shadow-footprint test. |
| `snow-mountain` | `(-33, -58)` | `[-2112, -2048)`, `[-3712, -3648)` | Steep snow/stone mountain face. Tests elevation contours, steep-slope shade, and shadow continuity without relying on a constructed roof. |
| `forest-coast` | `(-18, -23)` | `[-1152, -1088)`, `[-1472, -1408)` | Dense green coast with sand and open water. Tests shoreline placement, shallow/deep water transition, and tree-to-water boundaries. |
| `dark-canopy` | `(-56, -15)` | `[-3584, -3520)`, `[-960, -896)` | Dense, layered canopy beside water. Tests high-frequency occlusion, canopy edges, and whether shadow treatment leaks into flat interiors. |
| `flat-grass-shore` | `(-42, -8)` | `[-2688, -2624)`, `[-512, -448)` | Low-relief green terrain and shore. Negative control for false contouring or an unwanted global block grid; also checks water-edge height changes. |
| `dry-biome-boundary` | `(-14, -22)` | `[-896, -832)`, `[-1408, -1344)` | Mostly flat dry/yellow terrain with sparse trees, a small build, and water. Broadens material/biome coverage while keeping the relief low. |
| `technical-array` | `(-21, -10)` | `[-1344, -1280)`, `[-640, -576)` | Repeated dark-framed, coloured rectangular structures. A strong constructed-detail test for per-block models, regular edges, and narrow cast shadows. |

The first four are the minimum high-value run.  Keep the last three in routine
regression runs: they expose regressions which can hide in a village-only
comparison.

## Reproducible oracle render

Replace `<X>`, `<Z>`, and `<ID>` with a table row's lower bounds and ID.  Keep
the resulting PNG under `/tmp` or `.mapelix-tools`; both are outside the
Mapelix Git worktree.

```sh
/home/caches/Repos/.mapelix-tools/unmined-0.20.1/unmined-cli_0.20.1-dev_linux-x64/unmined-cli \
  image render \
  --world=/home/caches/Repos/.mapelix-tools/unmined-world-repair-20260817/world-classic \
  --output=/tmp/amelix-<ID>-unmined-z2.png \
  --area='b(<X>,<Z>,64,64)' \
  --zoom=2 \
  --shadows=3do \
  --background='#78a7ff' \
  --chunkprocessors=1 \
  --log-level=information
```

Render the identical bounds with Mapelix and compare the two lossless PNGs.
The normal structural diagnostic is:

```sh
pnpm --filter @mapelix/core diagnose:compare \
  /tmp/amelix-<ID>-mapelix-z2.png \
  /tmp/amelix-<ID>-unmined-z2.png \
  /tmp/amelix-<ID>-edges.png \
  4
```

## Metrics and review order

Do not score a published JPEG against a PNG with raw per-pixel error.  JPEG
noise, palette choice, and a possibly different saved state will dominate the
score.  The lossless local oracle makes more metrics useful, but structural
ones should still decide renderer changes.

1. **Registration:** record the best translation returned by
   `diagnose:compare`.  It should stay at or very close to `(0, 0)` for all
   seven tiles.  A common non-zero offset is a coordinate or raster-origin
   issue, not a lighting result.
2. **Edges:** record exact and one-pixel-tolerant Sobel precision/recall, plus
   the overlay.  Split the summary by scene category so a canopy improvement
   cannot conceal a flat-grass regression.
3. **False detail:** use `flat-grass-shore` and the flat area of
   `dry-biome-boundary` as negative controls.  Their interior edge energy
   should remain low; a gain in global edge count alone is not success.
4. **Shadow shape:** in `village-roofs` and `technical-array`, select a small,
   stable manual ROI around an overhang/array.  Threshold locally dark pixels
   relative to that ROI's median luminance, then compare dark-component area,
   centroid, and one-pixel-tolerant overlap.  This distinguishes a shadow that
   follows the roof's overhang from one that takes the maximum height-map
   footprint.
5. **Elevation:** for `snow-mountain`, compare gradient orientation and the
   connected length of dark contour edges, not merely their count.  For
   `forest-coast`, separately review water/shore edge position and shallow to
   deep water colour transition.

For each candidate change, inspect `village-roofs`, `technical-array`, and
`flat-grass-shore` first.  That gives one positive roof case, one regular
non-terrain construction case, and one low-detail negative control before the
full seven-tile run.
