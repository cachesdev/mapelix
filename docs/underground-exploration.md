# Underground exploration: Milestones 2–4

Engine and local viewer work following Milestone 1 (`67a3540`).

## Selection and navigation (Milestone 2)

The cave viewer supports optional integer X/Z bounds, with exclusive maxima and
16–256-block sides. The initial selection is 64 blocks around the camera focus.
Selections are retained per dimension during navigation and restored from shared
links (`minX`, `maxX`, `minZ`, `maxZ`). Surface rendering ignores the clip while
retaining that dimension's selection for a later return to caves.

The 3D box has Move and Resize tools. X/Z movement and resizing preview locally;
the Y handle proposes a section-aligned depth change when released. Height uses
the existing 16/32-block slice control. Orbit, keyboard and wheel camera input are
suspended during handle drags. Picking/collisions exclude hidden terrain.

Only intersecting reusable regions are requested. All terrain material families,
including lava/water and shadow masks, use the same clip. Neither horizontal
bounds nor arbitrary rectangles are included in terrain cache keys or requests.
The helper, geometries and material references are reused by the renderer owner
and disposed with it.

## Discoveries and buried resources (Milestones 3 and 4)

`SceneWorld.buildDiscoveries({ x, z }, signal)` returns serialized source indexes,
using the existing dimension worker pool and reader. Queued terrain precedes
discovery work; an already-running job finishes normally. Queued/active caller
cancellation settles promises and detaches listeners. Closing a pool settles both
queued and active callers.

Each source tile covers **32×32 blocks at every saved altitude**. It contains
vanilla ores (including host/lit variants and ancient debris), ordinary/trial
spawners, chests/trapped chests/ender chests, barrels, shulker boxes, decorated
pots, vaults, budding amethyst/crystals, sculk catalysts/shriekers/sensors,
portals/gateways and rails. See the browser-safe `./discoveries` catalog for exact
block names. Namespaced add-on blocks and live entities are not inferred.

Ore blocks are indexed even when fully surrounded by solid blocks. Six source
neighbors classify each indexed block as exposed, buried or unknown. Unknown
means that no known open face was found and a required neighboring chunk is
absent. A view boundary never changes this classification. Exposure uses the
same state-dependent block-shape rules as terrain, without building a mesh.

Client queries apply dimension, Y, X/Z, category, ore and exposure filters.
Six-connected groups merge across loaded source-tile boundaries. Counts describe
the blocks matching those filters; veins extending beyond the loaded area are
partial. A marker uses an actual member's coordinates, rather than a potentially
empty bounding-box center. Clicking a result opens the required cave slice and
focuses those coordinates. Markers remain independent of terrain LOD/visibility.
Navigation retains the chosen slice thickness, zoom, heading and pitch.

Only block types/coordinates and exposure flags leave the server. Container
contents, names and other block-entity compounds are not included. Rails,
amethyst and sculk evidence is not a full structure detector. Existing generated
chunks are searched; the mapper does not generate or predict unexplored chunks.

Discovery filters are preserved across view changes, reloads and shared links,
including customized filters while discoveries are hidden. Browser storage is
optional; explicit URL state takes precedence. All users may use every category.

## Limits and lifecycle

- Discovery streaming is opt-in, initially 64 blocks around the focus, with one
  request in flight. It waits for outstanding terrain work before starting new
  requests. No source requests run when all categories/types are deselected.
  Whole source tiles intersecting that nominal area are fetched; their corners
  can extend beyond it. Explicit X/Z selections filter the indexed blocks exactly.
- Encoded discovery caches are separate from terrain: 4 MiB locally on the server
  (`MAPELIX_DISCOVERY_MEMORY_MIB`), and 4 MiB/64 tiles in the browser by default.
  The local server also limits entries to 256 and writes no discovery files.
- The client narrows its wanted tile set if encoded tile sizes exhaust its byte
  budget. Old entries are evicted automatically. Snapshot/dimension changes abort
  requests and clear old source data; depth/filter changes reuse source indexes.
- Queries retain at most 100,000 matching blocks for grouping and the nearest
  128 groups/markers. Reaching a display/processing/cache limit is explicit in the
  UI. Narrowing the filters/depth or moving closer makes other results available.
- Grouping is cooperative: the render loop advances a generator for approximately
  2 ms per frame, with yields every 256 scanned/visited blocks. A bounded heap
  retains nearest groups without a large final sort. Changed views cancel old
  grouping jobs. No additional browser worker, GPU texture or material is needed
  for markers; at most 128 DOM buttons are retained and removed on disposal.
- Local snapshots are fixed for the server process. Restart for a new copy.
  Production revision replacement and bounded disk quotas remain adapter-owned.

## Server and host contract

The region binary format remains **2**; discovery packets have their own
**schema/detector version 1** (`MXD1`). A server exposes these features
alongside the canonical context from [Milestone 1](underground-rendering.md).
Legacy metadata without discovery capabilities causes no discovery requests.

1. Add `snapshotRevision` to metadata independently of terrain/generator revision.
   Advertise `discoveries.schemaVersion=1`, `tileSpan=32` and supported limits only
   when the discovery endpoint exists. Keep older dimension/ceiling defaults.
2. The local endpoint is `GET /discoveries/{x}/{z}.bin?dimension=…&revision=…&schema=1`.
   Here `revision` is **snapshotRevision**. A stale revision returns 409; invalid
   dimension/schema/coordinates return 400. Requests do not include view bounds,
   modes, LODs or filters. Those are client queries over reusable source tiles.
3. Cache identity is snapshot + discovery schema/detector + dimension + source X/Z.
   Bump the discovery version if catalog order, detection/exposure semantics or
   encoding changes. Region mesh revisions must not invalidate source indexes.
4. Preserve `regionBase`/`regionSuffix` and the existing `.bin` terrain suffix.
   New viewer options are `discoveryBase`, `discoverySuffix`,
   `discoveryMemoryBudget`, initial `discoveryFilters`, initial `selection`,
   `onSelectionChange` and `onDiscoverySelect`. Options survive `setWorld`.
5. The host may use `setSelection`, `setSelectionTool`, `setDiscoveryFilters`,
   `focusOn` and the `snapshot().selection`/`.discoveries` state for its own UI.
   It owns metadata loading when a Y-box gesture or discovery selection changes
   the vertical window. After `setWorld(newMetadata, true)`, call `focusOn(group)`
   when navigating to a discovery. Group data includes its dimension, count,
   exposure breakdown, bounds and representative block coordinates.
6. Keep production Surface, caves and discoveries in protected cache partitions.
   Start discovery encoded RAM at 4 MiB and consider a separate 64 MiB disk cap,
   with automatic eviction and old-snapshot cleanup. No all-depth/all-world
   discovery prewarming is needed.
7. A host may supply its own controls, preferences and callbacks; it need not
   copy the prototype's Svelte panels.

## Validation

The engine's **182 tests** and viewer's **18 tests** pass. The full browser run
passes **22 scenarios**, without failures, retries or skips, on actual WebGPU and
forced WebGL 2. Four subsequent targeted checks also pass after the final UI
preference changes: 16-block slices, zoom, hidden filters and reloads. Builds,
type checks and lint pass, with only the two pre-existing foliage-test warnings.

Each backend completes **104 Surface/Caves/Nether/End switches**, exercising real
region/index requests, cave markers, both box tools and forced mesh disposal
after switch 52. At equivalent warmed checkpoints (switches 20 to 104):

| Backend | Uniform buffers | Textures | JS heap           | Renderer allocation change |
| ------- | --------------- | -------- | ----------------- | -------------------------- |
| WebGPU  | 75 to 70        | 18 to 18 | 8.79 to 10.43 MiB | -54,672 bytes              |
| WebGL 2 | 77 to 72        | 18 to 18 | 9.04 to 10.66 MiB | -49,145 bytes              |

The intentionally unpooled path warms additional shader state. Its final
36-switch heap difference is 327/329 KiB, below the existing 512 KiB regression
allowance. Encoded discovery bytes and DOM marker counts are bounded; disposing
the viewer removes its canvas and marker layer. These counters describe logical
renderer allocations and live JS heap, not physical GPU residency.

Real-snapshot source-index measurements, using a nominal 64-block search area:

| Dimension | Source tiles | Indexed blocks | Payload       | Index generation |
| --------- | ------------ | -------------- | ------------- | ---------------- |
| Overworld | 25           | 33,037         | 132,948 bytes | 203.54 ms        |
| Nether    | 25           | 11,221         | 45,684 bytes  | 72.19 ms         |

The Overworld survey includes one ordinary spawner, 21 trial spawners and 20
vault blocks. These are local saved-block counts in the surveyed tiles, rather
than counts for the entire world. Grouping all types/all heights takes about
45.21/6.81 ms synchronously; the cooperative equivalent is divided into 21/4
steps, with observed maximum steps of 2.49/2.12 ms. These desktop observations are
descriptive, not browser frame-time or production latency guarantees.

One shared worker also completes four Surface prewarm jobs and requests from
three simulated visitors (three cave regions plus three source indexes) in
643.31 ms. This is the generic queue, not a production scheduler or cache.
The generation/mixed-workload harness peaks at 251.22 MiB process RSS and settles
at 182.39 MiB RSS / 10.98 MiB heap after collection. A separate full key inventory
raises the harness high-water mark; that inventory is not part of an ordinary
discovery request. None of these Windows figures establish production VM headroom.

The supplied snapshot has 487 occupied Overworld source tiles and 222 Nether
source tiles: **709 possible occupied index entries for one snapshot/schema**,
with one all-height result per tile. Different slices, LODs, filters and X/Z
selections do not multiply this number. Requests for absent tiles are separately
bounded by cache bytes/entries. Actual disk quotas still need adapter validation.

Manual Chrome checks on the real copy confirm the box, chamber discoveries,
buried diamonds and buried Nether debris, without browser errors. All 14 source
file fingerprints remain unchanged. The snapshot has no End chunks; End uses
generated Bedrock data until a real copy is available.

Full counters and measurements are in
[the validation artifact](benchmarks/underground-exploration-2026-11-13.json).
Use the normal root Turborepo build/check/lint/unit tasks and
`pnpm turbo run test:e2e --filter=@mapelix/prototype-viewer-3d` to reproduce the
automated checks. Set `MAPELIX_TEST_BROWSER=chrome` for installed Chrome. A manual
example on the copied world is:

```text
/?dimension=overworld&mode=caves&minY=-32&maxY=0&x=7&y=-16&z=72&distance=60&heading=56&pitch=60&discover=spawners,vaults
```
