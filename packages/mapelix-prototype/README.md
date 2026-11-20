# `@mapelix/prototype`

This package is the Mapelix prototype module. It is pure TypeScript and has no native image or LevelDB dependency.

The Node interface is small:

```ts
import { openBedrockWorld, writeLeafletTile } from "@mapelix/prototype";

const world = await openBedrockWorld({
  directory: "/srv/amelix/world",
  renderConcurrency: 2,
});
try {
  const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
  await writeLeafletTile(tile, { root: "generated-tiles" });
} finally {
  await world.close();
}
```

This writes `generated-tiles/0/0/0.png`. A Leaflet grid layer can request the output with `/tiles/{z}/{x}/{y}.png`.

Tiles are always 256 by 256 pixels. Native zooms 0 through 3 render blocks at 1×1, 2×2, 4×4, and 8×8 pixels, so each higher zoom covers half as many blocks per axis. Tile `y` follows Minecraft Z. Missing chunks are transparent.

For a future live source, `createBedrockWorld(effectiveRecords)` bypasses file access and accepts Bedrock key/value records directly. This is the intended Canopy seam.

The Node-only `@mapelix/prototype/png` adapter exposes the existing `encodePng` codec and an
expected-size `decodePng(bytes, width, height)` function. Core reuses these for overview PNGs without
duplicating the codec or adding an image dependency. Decoding rejects mismatched header dimensions
before inflation; callers choose the expected dimensions. The native renderer's PNG encoding is
unchanged.

## Lifecycle

Both world constructors return a `BedrockWorld` with an asynchronous, idempotent `close()`.
Closing rejects new render requests immediately, waits for every accepted render (including queued
work), terminates worker threads, and releases the retained record index. Render failures remain on
their original promises and do not prevent cleanup. After closing starts, `getTileCoverage()` throws
and `renderTile()` returns a rejected promise.

Use `await world.close({ abort: true })` to reject queued and running requests with an error named
`AbortError` and terminate workers instead of waiting for their renders. It can also interrupt a
graceful close already in progress; both calls await the same cleanup. Awaiting close guarantees that
every accepted request has settled and all workers have stopped. Repeating either form is safe.

In the main-process rendering path, file reads are abortable and cancellation is checked before and
after synchronous decoding/rendering. JavaScript cannot interrupt a synchronous operation on its own
thread: a close request takes effect when that thread can run it. Byte-backed renders are synchronous
and closing does not revoke a tile that has already finished. Hosts that require a hard wall-clock
limit must also supervise the rendering process.

The directory reader opens files only for individual reads, which close their own file handles.
`close()` releases its in-memory index and worker resources. Idle workers do not keep a process alive,
but long-lived callers should still use `try`/`finally` to release resources explicitly. Byte-backed
worlds created by `createBedrockWorld()` release their retained records when closed.

## Prototype boundaries

The opt-in `surfaceRange` render option supplies a dimension's full, half-open `minY`/`maxY` bounds
and its included `topY`. It clips surface selection and shadow runs and enables fixed-slot Data3D
biomes, including repeat-below storages. Omitting it preserves the archived rendering behavior.
The production [`@mapelix/core`](../mapelix-core/README.md) adapter validates vanilla dimension
profiles and supplies this range.

The additive `surfaceStyle` option maps exact block names to RGBA colors, biome-tint policy,
color-changing state variants and optional `decorative` classification. Fixed colors bypass generic
biome grass/foliage tint; other entries retain an explicit tint. Declarative variants are resolved
once per decoded palette entry, including in translucent layers. Decorative
cover uses the terrain's support height and contributes no full-block shadow opacity. Core owns
the production catalog; omitting this option retains the archived palette and classification.
The shared source is `@mapelix/core/appearance`, also used by the 3D scene renderer. The reference
adapter receives only its serialized top-view profile and has no runtime dependency on core.
All serializable render options remain eligible for tile workers, including shadows, biome blending,
reference corrections and surface diagnostics. Existing custom color resolver callbacks take
precedence over declarative colors and use the main-process fallback. `forceWorkers: true` on
`openBedrockWorld` enables workers even at concurrency one and refuses nonserializable callbacks.
Its optional `signal` cancels startup file reads; close an opened world to cancel its renders.
`renderCacheMiB` (default 256, per renderer) bounds the record and chunk-surface caches reused by
consecutive tiles; `0` disables them. Rendered pixels do not depend on it.

- Reads Bedrock LevelDB `.ldb`, `.sst`, and `.log` files, including tombstones and sequence ordering.
- Decodes persistent palette subchunks v8 and v9. Other subchunk versions fail with a clear error.
- Uses the primary block storage layer. It does not render waterlogging overlays, entities, structures, or texture packs.
- Reads legacy Data2D biome IDs in their Bedrock Z/X row order and modern Data3D biome palettes in X/Z/Y voxel order. The Data3D biome at the visible block height takes priority; Data2D remains the fallback.
- Uses uNmINeD-compatible classic biome colors for grass, foliage, and biome-family water. Biome tint is discrete by default; callers can request an artistic seam-safe transition with `biomeBlendRadius`.
- Uses byte-exact water-depth composition, the uNmINeD Bedrock elevation color and lightness curves, a selective one-pixel contour on shared height edges, and native output-subpixel 3D-opacity shadows. The default shadow pass uses the published 120-degree sun direction, 45-degree altitude, 40% strength, ray-chord-smoothed water and foliage opacity, and compact vertical occupancy runs so light can pass below roof overhangs. Equal-height interiors stay flat. Paths and common village materials use distinct style colors. Callers can disable shadows or inject a `BlockStyleResolver`. Reference-renderer quirks remain enabled by default for clean-room image parity; pass `correctReferenceBugs: true` to opt into Mapelix corrections, currently a physical top-face shadow receiver.
- Treats grass, flowers, ferns, and saplings as decorative cover supported by the ground below, so they do not create false terrain relief. The untextured renderer keeps a flat same-material region uniform; it does not use generated grain or resource-pack textures.
- Directory reads verify manifest and required journal CRCs, and the CRCs of table blocks they read.
- Builds the index one database file at a time. It retains packed subchunk and Data3D keys and only the compact biome payload from Data2D records. Block and Data3D values load on demand. More workers increase throughput and temporary memory use.
- Follows `CURRENT` and its manifest to select active tables and recovery journals. Unreferenced tables are never opened; invalid or unsupported manifests fail without a directory-scan fallback. See [snapshot integrity](../../docs/leveldb-snapshots.md).

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
