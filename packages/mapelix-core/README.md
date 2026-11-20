# `@mapelix/core`

Production-facing classic 2D profiles, shared block colors and a small renderer adapter.
The reference renderer remains in `@mapelix/prototype`; this package applies production profiles
without duplicating its algorithms or changing the archived defaults.

## Dimension profiles

The root entry contains profile metadata and types, with no Node.js runtime imports:

```ts
import { surfaceProfile } from "@mapelix/core";

const profile = surfaceProfile("nether");
// minY: 0, maxY: 128, topY: 90
```

| Dimension   | Storage ID | Physical block heights | Default included `topY` |
| ----------- | ---------: | ---------------------- | ----------------------: |
| `overworld` |          0 | -64 through 319        |                     319 |
| `nether`    |          1 | 0 through 127          |                      90 |
| `the-end`   |          2 | 0 through 255          |                     255 |

`minY` is inclusive and `maxY` is the exclusive physical bound. `topY` is the highest **included**
block. It is never rounded to a section boundary: `topY: 90` includes Y90 and excludes Y91. A supplied
cut must be an integer within the dimension's physical range. `topY: 127` retains the Nether roof.

The 2D cut is independent of the 3D renderer's exclusive, section-aligned mesh ceilings and its
defaults. These helpers do not modify a 3D scene context.

## Render from a read-only snapshot

Filesystem access and PNG rendering are in the separate Node entry:

```ts
import { writeFile } from "node:fs/promises";
import { openMapWorld } from "@mapelix/core/node";

const world = await openMapWorld({
  directory: "/path/to/immutable-snapshot",
  renderConcurrency: 2,
});
try {
  const tile = await world.renderTile({ dimension: "nether", z: 2, x: 0, y: 0 });
  await writeFile("nether.png", tile.png);

  // Render the same location with the roof retained.
  const roof = await world.renderTile({ dimension: "nether", z: 2, x: 0, y: 0 }, { topY: 127 });
  await writeFile("nether-roof.png", roof.png);
} finally {
  await world.close();
}
```

`createMapWorld(effectiveRecords)` provides the same API for an iterable of effective Bedrock
key/value records. The caller must already resolve sequence ordering and tombstones. Both
constructors apply the selected dimension's profile on every tile request and expose stored
zoom-0 coverage through `getTileCoverage(dimension)`.

The reader performs no writes. The caller owns output files, cache policy and snapshot lifecycle.
Use an immutable snapshot; both readers follow the same checked CURRENT/manifest selection.

## Validate a snapshot without rendering

```ts
import { validateSnapshot } from "@mapelix/core/node/snapshot";

const result = await validateSnapshot("/path/to/immutable-snapshot", {
  timeoutMs: 300_000,
  maxInputFileBytes: 268_435_456,
});
if (!result.valid) throw new Error(result.errors[0]!.message);
```

This lightweight Node entry does not load the renderer or open caches. `@mapelix/core/node`
also re-exports the API. It checks every selected table's data, index, metadata and filter blocks,
the manifest and required journals, then verifies source stability. Its revision equals the 2D
export's `source.revision`. It never opens inactive tables or changes input contents or rights.
The result contract is `mapelix-snapshot-validation`, schema version 1. Invalid snapshots,
cancellation and timeouts return `valid: false`; invalid API arguments reject with TypeError or
RangeError. Values and optional `level.dat` remain opaque; this is LevelDB integrity validation,
not Bedrock payload decoding. See the [full contract](../../docs/snapshot-validation.md)
for limits, JSON fields, errors, release entries and CLI exit codes.

## Surface behavior

- The physical floor and included top are applied before selecting surface blocks and shadow runs,
  including the neighboring shadow halo. Excluded roofs cannot shadow the retained terrain.
- Water depth and translucent color layers are measured within the visible range. Decorative cover
  above the cut is removed before choosing its supporting terrain height.
- Data3D biome slots start at the dimension's physical minimum, independently of missing block
  sections or the visible cut. A `0xff` storage repeats the previous biome slot. Data2D remains the
  fallback when the visible voxel has no Data3D value.
- Classic rendering, relief, opacity shadows and 256px XYZ coordinates are reused. Native
  zooms 0..3 are inherited from the reference renderer. The separate overview compositor and batch
  exporter add -4..-1 from native zoom-zero pixels, without changing the native rendering path.
- The reference renderer still uses its archived behavior unless given the new `surfaceRange`
  option. This package supplies that opt-in range; callers do not need to construct it themselves.

## Appearance

The default `appearance: "modern"` uses the same catalog and color-resolution rules as the 3D
renderer. The portable `@mapelix/core/appearance` entry owns 1,276 sampled palettes, their conditional
variants, the complete 1,466-identifier registry and the existing tuned color/alias rules. The scene
package consumes this entry through its compatibility imports; there is no separate 2D RGB table.
Biome definitions remain shared through `legacyBiomeStyle` in the reference package.

The 2D adapter selects the upward-facing color, including horizontal logs, and resolves color-changing
palette states before surface extraction. Fixed poplar/pale-oak foliage survives biome changes;
ordinary grass, foliage and water still use the shared biome definitions with classic 2D lighting.

Listed small ground decorations use the terrain's support height and add no full-block shadow
opacity, including in the neighboring shadow input. Their visible names and included block heights
remain available in surface diagnostics.

Select `appearance: "reference"` to retain the previous colors and decorative classification while
keeping the dimension bounds, biome layout and included `topY` behavior:

```ts
const reference = await world.renderTile(
  { dimension: "overworld", z: 2, x: 0, y: 0 },
  { appearance: "reference" },
);
```

An unsupported appearance is refused with `RangeError`. A supplied `resolveBlockStyle` callback
takes precedence over the fixed catalog colors. These are classic flat colors, with no resource-pack
textures or block-model rendering. See the [2D color catalog](../../docs/2d-block-colors.md) for
the shared source, top-view adaptations and limitations. Bed dye variants are available when supplied
in palette states; the 2D snapshot reader does not yet read bed dyes from block entities.

All serializable render options use the worker pool when it is enabled, including shadow toggles,
biome blending, reference corrections and surface diagnostics. `renderConcurrency: 1` retains the
reference adapter's main-process execution unless `forceWorkers: true` is supplied. Larger values
use workers. A `resolveBlockStyle` callback uses the main-process fallback, or is refused clearly
when forced workers are requested. An optional startup `signal` cancels index reads.
`includeSurface: true` adds diagnostic block, height, biome and opacity-run metadata.
Each renderer keeps bounded caches of database records and extracted chunk surfaces, so
neighbouring tiles and native zooms do not decode the same chunks again. `renderCacheMiB` sets
the budget per renderer (default 256, `0` disables reuse); pixels are identical either way.
Batch exports store per-chunk source fingerprints; `incremental: true` then re-renders only tiles
whose dependencies changed and copies the others, with output identical to a full render.
`surfaceCache: true` (or `{ maxMiB }`, default 512) also keeps extracted chunk surfaces in
`<output>/.mapelix-surface-cache` between exports, so re-rendered tiles only extract changed chunks.
Entries are verified when read; deleting or damaging the cache never changes the output.

## Cleanup

`close()` drains accepted work and releases retained records and workers. `close({ abort: true })`
aborts unfinished requests with `AbortError`, and can escalate a graceful close. Repeated calls are
safe. Further rendering is refused after closing starts. Main-process synchronous work has the same
cooperative cancellation limitation documented in the
[reference lifecycle contract](../mapelix-prototype/README.md#lifecycle).

## Batch export

The opt-in Node entry owns a generic exporter with a bounded worker queue, read-only snapshot
fingerprinting, a versioned manifest and atomic publication. It is independent of HTTP and any host:

```ts
import { renderBatch } from "@mapelix/core/node/batch";

const result = await renderBatch({
  world: "/srv/snapshots/world",
  output: "/srv/maps/export", // Parent must exist; input and output must be disjoint.
  dimensions: ["overworld", "nether", "end"],
  zooms: [-4, -3, -2, -1, 0, 1, 2], // Default classic range; explicit native +3 is still supported.
  limits: { workers: 2, maxPending: 2, maxTiles: 10000, timeoutMs: 300000 },
  signal: AbortSignal.timeout(300000),
});
console.log(result.manifestPath);
```

The caller gets a `PublishedBatchManifest`, elapsed milliseconds and sampled process-wide peak RSS.
The default memory budget is 2048 MiB. It is a sampled budget, with possible overshoot; the deadline
requests cancellation and permits 250 ms for an aborting close before worker-tree termination.
Cleanup completes before rejection. A final successful publication rename wins a cancellation race.

The CLI is [`@mapelix/render-cli`](../../apps/render-cli/README.md). Its documentation defines every
limit, manifest field, output path and filesystem assumption, including crash/power-loss limitations.
The root portable entries do not import this Node exporter.

The portable root also exports `mapPixelsPerBlock`, `mapTileBounds`, `mapTileAncestor` and
`DEFAULT_MAP_ZOOMS`. The Node entry exposes `createOverviewTile` for synchronous/asynchronous
iterables of zoom-zero RGBA, plus `encodePng` and expected-size `decodePng`. Missing sources stay
transparent; colors use alpha-weighted area sums with one rounding step at the target zoom.
`MapWorld.renderTile` itself remains native-only. See the [overview contract](../../docs/2d-overviews.md)
for negative coordinates, seam behavior, source reuse and resource accounting.

## Validation

From the repository root:

```sh
pnpm exec turbo run test:unit --filter=@mapelix/core --filter=@mapelix/prototype
pnpm exec turbo run check lint --filter=@mapelix/core
```

Tests cover all three dimensions, exact included cuts, negative coordinates and heights, missing and
repeated biome slots, water/glass/decorative layers, shadow casters outside the cut, real worker
transport, recent block colors across biomes, negative tile seams and reader/byte-renderer parity.
A child-process import test rejects Node builtins to verify both the root and appearance entries.
The existing 3D application and its rendering behavior remain unchanged.
