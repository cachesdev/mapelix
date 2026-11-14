# Underground exploration: Milestone 0 measurements

Historical status at Milestone 0: measurements complete; the server API is **not frozen**.
Base engine/viewer is
`e02cf7c51241170916eaf116c419a7d54c7c1916`, on independent branch
`experiment/underground-m0`. No production server was changed. This archived report and its baseline-specific
tools are retained alongside the subsequent
[Milestone 1 implementation](underground-rendering.md); the findings below
describe the experiment, rather than the current shipped engine.

The approved architecture remains: one vertical window, an explicit caves
visibility strategy, reusable horizontal regions, independent snapshot-based
discoveries, optional X/Z selection and a later interactive 3D selection box.
All features remain intended for every visitor, with common operational limits.

## Method and evidence

The experiment copies compiled engine modules into an ignored directory and makes
bounded, explicitly experimental changes there. It does not change engine exports
or the public viewer interface. It reads only intersecting source sections plus
neighbor sections, bounds the detailed voxel allocation, retains closed cavities
below Y 0, and emits source-natural faces without an artificial cut-plane cap.
Existing detailed block models, materials, packed quads and lava flags are reused.

Environment: Windows, Node 24.14.1, AMD Ryzen 7 7800X3D, 16 logical CPUs. This is
the development machine, **not the production VM**. Each matrix case has a fresh
worker, an initial application-cache-cold build and ten additional builds, with
two discarded warmups. Median and empirical p95 use eight measurements; this small
sample is descriptive, not a production latency SLA. Filesystem caches are not
purged. CPU time is process user+system time; RSS includes the controller and worker.

The snapshot contains 1,697 Overworld chunks and 747 Nether chunks, with no stored
End chunks. All **14 source files remain SHA-256 identical** after validation.
End browser validation uses a generated model catalog. Source files are opened
read-only; generated fixtures and caches are confined to ignored experiment paths.

[Structured measurements](benchmarks/underground-m0-2026-11-13.json) retain the
67-case matrix, concurrency rows, cache-growth trace and lifecycle summaries.
[Reproduction tools](../tools/underground-m0/README.md) explain each experiment.

## Boundary and compatibility decision

`ceilingY` is already exclusive. The compatibility rule is:

```text
maxY = ceilingY
minY <= blockY < maxY
```

There is no `+1` conversion. For example, `ceilingY=-32` includes block owners
through Y -33 and excludes block owners at Y -32. A natural top face of block -33
may lie exactly at Y -32; the coordinate of that face does not make block -32 part
of the window. A solid block outside a caves window must not create a fake visible
top face at the cut boundary.

Validation includes **162 positive assertions and 8 invalid/conflicting cases**:
legacy/default encoded bytes across dimensions and LODs, exact negative bounds,
canonical aliases, a closed negative-Y tunnel, an eight-block exploratory window,
and natural-versus-artificial cut faces. Conflicting `ceilingY`/`maxY` values are
rejected. Equal aliases normalize to one key. A default surface cut and a caves
view with the same bounds deliberately have different keys: their geometry differs.

Canonical context for the future contract is therefore dimension, visibility
strategy and one half-open vertical range. The existing default remains unchanged:
Overworld -64..320, Nether 0..96, End 0..256. Metadata dimension bounds must remain
distinct from the selected window and from actual encoded mesh extents.

A region identity must also contain the snapshot revision, LOD and region X/Z.
Optional X/Z selection chooses reusable tiles; selection rectangles and a future
interactive box must not create another copy of identical terrain tiles. Discovery
index identity is independent of terrain strategy, window and LOD.

The binary region format stays 2. The HTTP negative-number parser, a versioned host API,
transport capability negotiation and rollback compatibility remain server
work. Configurable URL bases, `.bin`, revision and existing dimension semantics
must be preserved. The experimental request parser is not the final contract.

## Region generation

Representative real Overworld region (-1, 0), window starting at Y -32:

| Thickness | LOD | Median ms | Empirical p95 ms | Payload KiB |
| --------- | --: | --------: | ---------------: | ----------: |
| 16        |   0 |     18.49 |            22.24 |          75 |
| 32        |   0 |     28.68 |            33.55 |          90 |
| 64        |   0 |     52.67 |            63.11 |         148 |
| 32        |   1 |    218.13 |           222.84 |         294 |
| 32        |   2 |    296.48 |           304.41 |         273 |
| 64        |   1 |    355.99 |           407.20 |         792 |

The unchanged surface L0 median on the selected region was 30.95 ms with an
81,480-byte payload. Across tested windows, a 64-block L1 region reached
1,049,088 bytes. L1 is still one block per voxel but covers four times L0's area;
it is not a cheaper replacement for one L0 region. These rows must not be compared
as equal-area throughput figures.

A generated one-block tunnel remains represented at L0 and L1 and closes at L2.
Consequently L2 is not accepted for near-camera cave navigation. Greedy face count,
not just voxel size, determines cost; a reduced mesh can still be expensive.

The prototype includes conservative section halos and an extra clipping/serialization
pass. Its existing column-based tint preparation is not yet altitude-correct cave
biome blending. Final biome work may split additional quads. These are prototype
measurements, not the final mesher's performance guarantee.

## Maximum cache variants

For a dimension of H blocks, aligned to 16, a window of thickness T has
`(H - T) / 16 + 1` placements. Sum these placements across allowed thicknesses,
then multiply by eligible region coordinates at each supported LOD. Aliases do
not multiply variants. Regions outside the dimension's stored bounds are excluded.

| Dimension | Present chunks | L0 present / bounding rectangle | L1 present / bounding rectangle | Windows 16/32/64 | L0+L1 variants, present / rectangle |
| --------- | -------------: | ------------------------------: | ------------------------------: | ---------------: | ----------------------------------: |
| Overworld |          1,697 |                       137 / 224 |                         42 / 64 |               68 |                     12,172 / 19,584 |
| Nether    |            747 |                         67 / 90 |                         22 / 25 |               20 |                       1,780 / 2,300 |
| End       |              0 |                           0 / 0 |                           0 / 0 |   44 theoretical |                               0 / 0 |

Total: **13,952 variants touching present chunks, or 21,884 inside served bounding
rectangles**, for the 16/32/64 presets at L0/L1. Counting only 16/32 reduces these
to **9,748 / 15,261**. The distinction matters because the current server advertises
a bounding rectangle which can contain holes. Some legal requests return empty
regions inside it. Existing default prewarming covers 466 region coordinates over
all six levels, matching the 330 Overworld + 136 Nether baseline.

These are caves-only counts. Including one existing default context per dimension
gives 15,727 bounding-rectangle variants for the initial 16/32 presets. If every
currently legal default-view ceiling remains available at all six LODs, default
contexts alone allow 9,008 rectangle variants (24 Overworld and 8 Nether ceilings).
Combining those with caves 16/32/64 gives an upper bound of **30,892** for this
snapshot. This is a namespace cardinality, not an instruction to generate them all.
The separate explicit visibility strategies prevent accidental cross-mode reuse.

Allowing every 16-aligned thickness up to 64, including 48, increases the allowed
window counts to 90 Overworld and 26 Nether. Step-8 placements would multiply them
further. A future End with data adds its own coordinate count; it is not free just
because this snapshot lacks End chunks. Full exhaustive prewarming is rejected.

## Concurrent usage and prewarming

Independent local simulation: four requested regions per visitor, up to 16 unique
cave keys; all computation shares the configured worker budget. The background
prewarm submits one default-view job at a time at L5, L3, L1 and L0. Foreground
requests precede queued background work but cannot interrupt an active build.

| Workers | Visitors | Prewarm | Foreground p95 ms | CPU ms for entire scenario | Peak process RSS MiB |
| ------: | -------: | ------- | ----------------: | -------------------------: | -------------------: |
|       1 |        1 | No      |               319 |                        500 |                  132 |
|       1 |        1 | Yes     |               915 |                      2,593 |                  225 |
|       1 |        5 | No      |               670 |                      1,140 |                  170 |
|       1 |        5 | Yes     |             1,416 |                      2,985 |                  281 |
|       1 |       20 | No      |               731 |                      1,077 |                  203 |
|       1 |       20 | Yes     |             1,292 |                      2,907 |                  270 |
|       2 |       20 | No      |               473 |                      1,640 |                  239 |
|       2 |       20 | Yes     |               760 |                      3,391 |                  318 |

The 20-visitor burst makes 80 logical requests, coalesces 64 and needs 16 cave
builds; prewarm adds four separate default builds. Warm repeats come from the
local encoded cache and take 0.03..0.15 ms for the entire in-process batch, excluding
HTTP, compression and network transport. This is not a public HTTP latency claim.

Two workers improve the burst but raise memory and CPU. The initial recommendation
is one shared worker, not a new pool per mode. Starting a coarse prewarm task can
add approximately 0.6..0.7 s to the observed foreground tail. Pause submission of
new prewarm work while visitors are waiting. Proxying, request throttling and
production admission policy belong to the production server; this harness modifies none of them.

## Cache growth and eviction

The growth test generates 168 different real regions across depths, thicknesses,
positions and L0/L1, then revisits 24 keys. It writes actual region files with
deliberately small, separate 8 MiB disk / 2 MiB encoded-memory quotas to force LRU
eviction. This demonstrates a proposed partition, not scene-server implementation.

- Maximum retained cave disk data: 8,386,560 bytes, below 8 MiB after eviction.
- Maximum retained encoded cave memory: 2,096,736 bytes, below 2 MiB after eviction.
- 154 evictions by the end of the first exploration pass.
- 12 of 24 revisits rebuild; the other 12 reuse retained results.
- The protected 81,480-byte Surface entry survives unchanged.
- Clearing the simulated obsolete revision leaves zero old region files.
- Peak process RSS is 375 MiB while varying the extraction/LOD caches, despite
  only 2 MiB being allocated to retained encoded cave entries.

An encoded-region quota does not cap the decoder, mesher, V8 or renderer RSS.
Writes can transiently hold the new entry before eviction. A server's existing
old-revision directory cleanup remains the baseline; it must also cover future
discovery data. No obsolete revision cleanup is changed here.

Suggested initial cave budgets are **16 MiB encoded RAM and 128 MiB disk**, each
configurable and separate from protected Surface data. These values do not prove
that the production service fits its MemoryHigh limit. Worker/decoded caches and
temporary meshing allocations still need the production VM check.

## Engine view-switch memory

An additional shared-worker test cycles the same four views 1,040 times. One
builder per dimension is deliberately retained, bounded at three. It exercises
the real snapshot, whose End is empty; the nonempty End rendering test below
uses generated data. Garbage collection is requested at equivalent End checkpoints
to distinguish reachable data from temporary allocations. This test does not model
a production worker-pool shutdown policy or production garbage-collection timing.

At switches 104 and 1,040 the worker heap is 12.01 and 12.11 MiB, and retained
ArrayBuffer accounting is 25.89 MiB at both checkpoints. Over the final half of
the run, heap varies from 11.89 to 12.13 MiB. Process RSS initially rises with
allocator warm-up, then fluctuates between 185 and 228 MiB in that final half,
ending at 186 MiB. Some checkpoints include temporary buffer finalization spikes;
ArrayBuffer accounting is not interpreted as an instantaneous live-buffer census.
No continuing growth proportional to the number of view switches is observed.
This does not substitute for the integrated Linux/VM lifecycle test.

## 104-switch RAM and GPU lifecycle

Each backend switches Surface/Caves/Nether/End 104 times using one canvas and
renderer. Equivalent warmed End frames are compared. All views must load nonempty
terrain. Surface/Caves/Nether use precomputed real snapshot regions; End uses a
generated catalog. GPU live counters and JS heap are distinct from process RAM.

The unchanged viewer fails this test: live uniform buffers rise from 188 at switch
4 to 4,338 at switch 104 in WebGPU (WebGL shows the same pattern). Geometry disposal
alone does not dispose Object3D render state in installed Three.js 0.186.

Three related lifecycle measures are validated in the isolated harness:

1. Dispose discarded mesh objects as well as their geometries.
2. Retain a viewport-depth node for water outside the shader Fn callback, instead
   of producing new cached depth targets on material recompilation.
3. Keep a bounded pool of compatible mesh shells so recompilation does not grow
   Three's shared binding cache. The cap is 16 shells per material pair; the tested
   end frame retains seven unused shells. Their old quad arrays are cleared and
   their geometry GPU allocations disposed. Shared uniforms/programs remain live
   deliberately and are released with the renderer.

The two cleanup measures alone stabilize GPU counters but still grow a shared
CPU-side binding cache. Heap snapshots identify retained NodeUniform/BindGroup
objects through the render-context cache. Bounded reuse avoids that growth without
editing installed Three.js or using its private reset APIs.

The final control uses direct CDP without enabling Network capture, avoiding the
debugger's retained response bodies. From switch 20 to switch 104:

| Metric                                           |                   WebGPU |                  WebGL 2 |
| ------------------------------------------------ | -----------------------: | -----------------------: |
| Live uniform buffers                             |               102 -> 102 |               104 -> 104 |
| Live textures                                    |                 18 -> 18 |                 18 -> 18 |
| Total logical renderer bytes                     | 154,026,500 -> unchanged | 153,989,320 -> unchanged |
| JS used heap MiB                                 |           8.043 -> 8.277 |           8.173 -> 8.496 |
| JS heap range over final 52 switches, MiB        |             8.204..8.277 |             8.340..8.496 |
| Chrome private process-tree MiB                  |               761 -> 695 |               627 -> 586 |
| Chrome private range over final 52 switches, MiB |                 695..707 |                 576..589 |
| Shader/browser errors                            |                        0 |                        0 |

Counts and logical renderer bytes plateau exactly. Small remaining heap warm-up is
not an accumulating mesh/texture population; the final half of the run varies by
less than 0.16 MiB. Chrome process RAM fluctuates with driver/JIT/OS caches and falls
after warm-up; it is not interpreted as equal to live GPU allocation. Summed working
sets can double-count shared pages. These are resource-lifecycle measurements,
not direct physical VRAM measurements or an FPS/production-load benchmark.

Full disposal removes the canvas and releases the owned GPU device and its remaining
shared resources. The bounded-pool Playwright run also records zero remaining live
WebGPU device resources after disposal. The renderer's shared ~146 MiB texture
footprint is retained between views; it is not 146 MiB of new data per switch.

These corrections are **experimental harness changes only**. They must be ported
and regression-tested in the generic viewer before underground delivery. They are
not claimed to be deployed or committed.

## Recommended limits and remaining gates

- Preserve the architecture and public availability; no administrator-only mode.
- One shared generation worker initially; foreground work before new prewarm jobs.
- Default thickness 32; initial selectable thicknesses 16/32. Keep 64 as a measured
  candidate, enabled only after the target server budget is validated. Step-8 and
  arbitrary thicknesses remain later options, not assumptions in the server API.
- L0 near the camera and L1 where appropriate. Do not permit L2 for local cave
  navigation until a topology-preserving policy is demonstrated.
- Start with a 128-block cave streaming radius. A 256-block radius is a later
  candidate to measure. The lifecycle harness exercised 96, so 128 is a
  proposed starting limit, **not a measured multi-region GPU throughput result**.
- Propose a separate 32 MiB client quad-cache budget, in addition to fixed shared
  renderer resources, with dynamic distance reduction if drawn geometry exceeds it.
- Separate protected Surface cache from configurable 16 MiB RAM / 128 MiB disk
  cave quotas. Never prewarm every legal vertical window.
- Keep discovery extraction independent of meshing, cache by snapshot/dimension/
  source tile and detector/schema version, and apply equivalent revision cleanup.
  Discovery indexing itself is not implemented or benchmarked in M0.

Before freezing the server API: port lifecycle fixes and bounded reuse, decide capability-
advertised thickness/LOD limits, perform final biome/range tests, and
measure the actual service on its target server, including existing prewarm,
protected cache quotas, snapshot replacement, update and rollback. The reported
~110 MiB production headroom must not be replaced by Windows desktop RSS figures.
