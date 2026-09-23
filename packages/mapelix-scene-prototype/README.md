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

## Regions

Regions form a quadtree. A level 0 region covers 64 by 64 blocks, and each level up covers twice
as many blocks on each side, up to 2048 by 2048 at level 5.

- Level 0 is a voxel mesh. Faces between solid blocks and faces in sealed caves are dropped.
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

`MAPELIX_BENCH_X` and `MAPELIX_BENCH_Z` move the center. On the Amelix SMP world with eight
workers, a cold level 0 region takes about 0.45 s, a level 1 region about 1 s, a level 3 region
about 2.2 s, and a level 5 region about 16 s.
