# `@mapelix/scene-prototype`

This package turns a Bedrock world into 3D scene regions for the Mapelix 3D viewer. It reads the
world's LevelDB tables on demand and builds regions in worker threads.

```ts
import { openSceneWorld } from "@mapelix/scene-prototype";
import { decodeSceneRegion } from "@mapelix/scene-prototype/format";

const world = await openSceneWorld({ directory: "/srv/amelix/world", workers: 4 });
const built = await world.buildRegion({ level: 0, x: -1, z: 5 });
const region = decodeSceneRegion(built.bytes);
await world.close();
```

`openSceneWorld` reads the world name and spawn from `level.dat` and returns them as `info`. It
does not scan the database. Each worker opens the tables by their index blocks and inflates only
the blocks a lookup needs. `buildRegion` accepts an `AbortSignal`, which drops a request that no
worker has started.

## Dimensions

Pass `dimension: "overworld" | "nether" | "the-end"` to `openSceneWorld`. The default
is Overworld. Each world instance fixes its dimension, including worker and decoded-chunk
caches. The reusable `@mapelix/scene-prototype/dimensions` entry has no Node.js dependency.

| Dimension | Block range     | Geometry                                           | Default exclusive mesh ceiling |
| --------- | --------------- | -------------------------------------------------- | ------------------------------ |
| Overworld | -64 through 319 | Existing surface visibility and depth optimization | 320                            |
| Nether    | 0 through 127   | Full interior geometry, including sealed caves     | 96                             |
| End       | 0 through 255   | Full island geometry, void and undersides          | 256                            |

`buildRegion({ level, x, z, ceilingY })` optionally hides blocks at and above `ceilingY`.
The ceiling must be a multiple of 16, above the dimension floor and no higher than its
exclusive upper bound. It is applied before mesh generation and voxel reduction, so all
six LODs agree. Set the Nether ceiling to 128 to retain the roof.

The format remains version 2. Dimension and ceiling belong to the request/cache context,
not the binary header: adapters must key regions by world revision, dimension, ceiling,
level, x and z. The `sceneContext`, `contextSearch` and `regionCacheKey` helpers normalize
these values. `info.spawn` remains the Overworld spawn stored in `level.dat`; consumers
choose their own entry points into other dimensions.

See [milestone notes](../../docs/native-dimensions.md) for validation, limitations and the
server contract.

## Underground windows

`buildRegion({ mode: "caves", minY: -64, maxY: -32, level: 0, x, z })` keeps
natural enclosed cave faces in a half-open vertical window. Initial thicknesses
are 16/32 blocks (32 by default), aligned to 16, at LOD 0/1. `ceilingY` remains
an exact alias for the exclusive `maxY`. Omitting `mode` preserves previous
Surface/Nether/End geometry and default bounds.

The browser-safe context helpers normalize aliases and isolate cave cache keys
from Surface keys. Adapters must also namespace by snapshot revision. Binary
format remains 2. See [underground rendering](../../docs/underground-rendering.md)
for resource ownership, limits and the server contract.

## Source discoveries

`world.buildDiscoveries({ x, z }, signal)` indexes a 32×32 source tile at all saved
heights, using the same dimension worker budget at lower queue priority than
terrain. Decode its bytes with `decodeDiscoveryTile` from the browser-safe
`@mapelix/scene-prototype/discoveries` entry. Source indexes include fully buried
ores and useful vanilla blocks; they contain no container inventories.

Cache by snapshot revision, discovery schema/detector version, dimension and tile
coordinates. Depth, selection, exposure and type filters are client queries over
the same index. `queryDiscoverySteps` supports cooperative rendering; the
synchronous `queryDiscoveries` wrapper is for offline consumers. See
[Milestones 2–4](../../docs/underground-exploration.md) for limits and the adapter
contract. The separate `./selection` entry contains browser-safe clip helpers.

## Regions

Regions form a quadtree. A level 0 region covers 64 by 64 blocks, and each level up covers twice
as many blocks on each side, up to 2048 by 2048 at level 5.

- Level 0 is a voxel mesh. Faces between solid blocks are dropped. Overworld also drops sealed caves.
  Equal faces merge into larger quads, and each corner stores its ambient occlusion. Plants are
  crossed quads. Water and glass are separate translucent quads.
- Levels 1 to 5 are voxel meshes over 128 by 128 cubic voxels, 1, 2, 4, 8, and 16 blocks wide.
  Each level merges every 2 by 2 by 2 group of voxels below it into one, as
  [Voxy](https://github.com/MCRcortex/voxy) does. The upper half of a group decides first, so
  floors, roofs, and the sea surface keep their height, and blocks win ties against water.
  Voxels keep their material, a top color, and a side color. Snow and carpets color the top of
  the block below them, and grass sides keep their soil strip.
- Higher levels cull, merge, and shade faces as level 0 does. Walls that face unexplored land
  reach 16 blocks below the highest block, like the cut edge of a diorama. Borders reach under
  their neighbors so regions of different levels meet without gaps.
- Overworld higher levels read each chunk from the top down to 32 blocks below its ground, or 16 blocks
  for voxels 4 blocks wide and wider, and treat deeper blocks as rock. Ground is the top of at
  least 4 solid blocks, so towers of thin floors and high platforms keep the open air below them.

## Format

`@mapelix/scene-prototype/format` has no Node.js dependency. It encodes and decodes regions and
packs quads. A region is a 40-byte header, a height grid, and three quad lists: opaque, plants,
and translucent. Decoding returns views into the original buffer.

Each quad is three `uint32` words:

| Word | Contents                                                                            |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | Cell x, y, and z, face, material, and a covered-soil flag                           |
| 1    | Width and height along the face, box size and inset in sixteenths, and plant sprite |
| 2    | sRGB color and 2-bit occlusion for each corner                                      |

The viewer draws each list as one instanced unit square and rebuilds the corners in the vertex
shader.

## Benchmark

Build a square of regions around the spawn or a chosen block and report times and quad counts:

```sh
pnpm --filter @mapelix/scene-prototype build
MAPELIX_WORLD_DIRECTORY=/path/to/world \
MAPELIX_BENCH_LEVEL=0 MAPELIX_BENCH_RADIUS=1 MAPELIX_BENCH_WORKERS=8 \
pnpm --filter @mapelix/scene-prototype benchmark
```

Set `MAPELIX_BENCH_DIMENSION=nether` and optionally `MAPELIX_BENCH_CEILING_Y=80` to
measure another dimension or roof cut. Benchmark coordinates are always block coordinates
in the selected dimension; set `MAPELIX_BENCH_X` and `MAPELIX_BENCH_Z` explicitly.

`MAPELIX_BENCH_X` and `MAPELIX_BENCH_Z` move the center. On the Amelix SMP world with eight
workers, a cold level 0 region takes about 0.45 s, a level 1 region about 1 s, a level 3 region
about 2.2 s, and a level 5 region about 16 s.
