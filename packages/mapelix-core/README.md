# `@mapelix/core`

Production-facing classic 2D surface profiles and a small renderer adapter. The reference renderer
remains in `@mapelix/prototype`; this package introduces the production boundary without duplicating
its algorithms or changing its default appearance.

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
Use an immutable snapshot; the existing reader's LevelDB checksum/manifest limitations still apply.

## Surface behavior

- The physical floor and included top are applied before selecting surface blocks and shadow runs,
  including the neighboring shadow halo. Excluded roofs cannot shadow the retained terrain.
- Water depth and translucent color layers are measured within the visible range. Decorative cover
  above the cut is removed before choosing its supporting terrain height.
- Data3D biome slots start at the dimension's physical minimum, independently of missing block
  sections or the visible cut. A `0xff` storage repeats the previous biome slot. Data2D remains the
  fallback when the visible voxel has no Data3D value.
- Existing classic colors, relief, opacity shadows and 256px XYZ coordinates are reused. Native
  zooms 0..3 are currently inherited from the reference renderer. Overview zoom generation and a
  batch command are separate work; this package does not yet provide them.
- The reference renderer still uses its archived behavior unless given the new `surfaceRange`
  option. This package supplies that opt-in range; callers do not need to construct it themselves.

Requests containing only a surface range use the existing worker pool. Other reference rendering
options retain their existing scheduling behavior until the batch renderer's worker-profile work.
`includeSurface: true` adds diagnostic block, height, biome and opacity-run metadata.

## Cleanup

`close()` drains accepted work and releases retained records and workers. `close({ abort: true })`
aborts unfinished requests with `AbortError`, and can escalate a graceful close. Repeated calls are
safe. Further rendering is refused after closing starts. Main-process synchronous work has the same
cooperative cancellation limitation documented in the
[reference lifecycle contract](../mapelix-prototype/README.md#lifecycle).

## Validation

From the repository root:

```sh
pnpm exec turbo run test:unit --filter=@mapelix/core --filter=@mapelix/prototype
pnpm exec turbo run check lint --filter=@mapelix/core
```

Tests cover all three dimensions, exact included cuts, negative coordinates and heights, missing and
repeated biome slots, water/glass/decorative layers, shadow casters outside the cut, real worker
transport and reader/byte-renderer parity. A child-process import test rejects Node builtins to
verify the root entry's portable boundary. The existing 3D application remains unchanged.
