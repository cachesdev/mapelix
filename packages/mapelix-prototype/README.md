# `@mapelix/prototype`

This package is the Mapelix prototype module. It is pure TypeScript and has no native image or LevelDB dependency.

The Node interface is small:

```ts
import { openBedrockWorld, writeLeafletTile } from "@mapelix/prototype";

const world = await openBedrockWorld({
  directory: "/srv/amelix/world",
  renderConcurrency: 2,
});
const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
await writeLeafletTile(tile, { root: "generated-tiles" });
```

This writes `generated-tiles/0/0/0.png`. A Leaflet grid layer can request the output with `/tiles/{z}/{x}/{y}.png`.

Tiles are always 256 by 256 pixels. Native zooms 0 through 3 render blocks at 1×1, 2×2, 4×4, and 8×8 pixels, so each higher zoom covers half as many blocks per axis. Tile `y` follows Minecraft Z. Missing chunks are transparent.

For a future live source, `createBedrockWorld(effectiveRecords)` bypasses file access and accepts Bedrock key/value records directly. This is the intended Canopy seam.

## Prototype boundaries

- Reads Bedrock LevelDB `.ldb`, `.sst`, and `.log` files, including tombstones and sequence ordering.
- Decodes persistent palette subchunks v8 and v9. Other subchunk versions fail with a clear error.
- Uses the primary block storage layer. It does not render waterlogging overlays, entities, structures, or texture packs.
- Reads legacy Data2D biome IDs in their Bedrock Z/X row order and modern Data3D biome palettes in X/Z/Y voxel order. The Data3D biome at the visible block height takes priority; Data2D remains the fallback.
- Uses uNmINeD-compatible classic biome colors for grass, foliage, and biome-family water. Biome tint is discrete by default; callers can request an artistic seam-safe transition with `biomeBlendRadius`.
- Uses byte-exact water-depth composition, the uNmINeD Bedrock elevation color and lightness curves, a selective one-pixel contour on shared height edges, and native output-subpixel 3D-opacity shadows. The default shadow pass uses the published 120-degree sun direction, 45-degree altitude, 40% strength, ray-chord-smoothed water and foliage opacity, and compact vertical occupancy runs so light can pass below roof overhangs. Equal-height interiors stay flat. Paths and common village materials use distinct style colors. Callers can disable shadows or inject a `BlockStyleResolver`. Reference-renderer quirks remain enabled by default for clean-room image parity; pass `correctReferenceBugs: true` to opt into Mapelix corrections, currently a physical top-face shadow receiver.
- Treats grass, flowers, ferns, and saplings as decorative cover supported by the ground below, so they do not create false terrain relief. The untextured renderer keeps a flat same-material region uniform; it does not use generated grain or resource-pack textures.
- Does not validate LevelDB checksums yet.
- Builds the index one database file at a time. It retains packed subchunk and Data3D keys and only the compact biome payload from Data2D records. Block and Data3D values load on demand. More workers increase throughput and temporary memory use.
- Does not interpret `CURRENT` or `MANIFEST` yet. Point it at a clean world snapshot without orphaned LevelDB files.

## Color benchmark

Measure aligned per-block material colors against a lossless, shadowless oracle:

```sh
pnpm --filter @mapelix/prototype diagnose:color \
  path/to/mapelix-shadowless.png path/to/unmined-shadowless.png \
  /tmp/color-error.png 4 -32 -49 /tmp/color-report.json /tmp/surface.json
```

The command samples the 3×3 interior of each native 4×4 block cell, away from
the north and west contour pixels. It reports RGB and perceptual error
percentiles, worst world coordinates, and repeated candidate-to-reference
color pairs. It also ranks material names by total perceptual error and records
the worst XYZ sample for each material. Transparent cells and the uNmINeD
export background are excluded.
Use shadowless images for palette work; keep normal `3do` images for the
separate shadow comparison. When given a surface manifest from
`renderTile(..., { includeSurface: true })`, each outlier includes world XYZ,
block name, biome ID, and supporting terrain Y.
Water samples also include visible depth and the first block below the water.

Render normal and shadowless diagnostic tiles plus complete surface manifests
with one world-index scan:

```sh
MAPELIX_DIAGNOSTIC_WORLD=/path/to/world \
MAPELIX_DIAGNOSTIC_OUTPUT=/tmp/mapelix-diagnostics \
MAPELIX_DIAGNOSTIC_LABEL=palette-v10 \
MAPELIX_DIAGNOSTIC_TILES='[{"z":2,"x":-32,"y":-49}]' \
pnpm --filter @mapelix/prototype diagnose:render
```

Pass more coordinate objects in the JSON array to reuse the same in-memory
index. The command reports index time, tile time, process memory, and peak RSS.

Compare cast shadows independently from block colors and local contours:

```sh
pnpm --filter @mapelix/prototype diagnose:shadows \
  mapelix.png mapelix-shadowless.png unmined.png unmined-shadowless.png \
  /tmp/shadow-overlay.png 4 -32 -49 /tmp/shadow-report.json /tmp/surface.json
```

The command accepts lossless PNG files only. It derives per-pixel shadow loss
from each renderer's normal and shadowless pair, then reports mask precision,
recall, F1, loss correlation, and the worst receiver XYZ/subpixel samples.

## Visual regression suite

The package owns ten lossless Amelix/uNmINeD comparison scenes under
`test/visual-regression`. They preserve structure, per-block color, shadow,
alignment, and XYZ diagnostics for the renderer rewrite:

```sh
pnpm --filter @mapelix/prototype test:visual
```

The default run verifies the committed final prototype baseline. Set
`MAPELIX_VISUAL_WORLD` to render the current package from a Bedrock world before
running the same checks. See `test/visual-regression/README.md` for the input
contract and generated report layout.
