# Underground exploration: Milestone 1

This records the original Milestone 1 delivery. Subsequent selection and
discovery work is documented in [Milestones 2–4](underground-exploration.md).

Engine and local viewer implementation based on `e02cf7c`, with regression tests
and archived Milestone 0 measurements. Resource discovery indexing and the 3D
selection box came later.

## Canonical context

The browser-safe dimensions module accepts the original
`sceneContext(dimension, ceilingY)` signature and the new
`sceneContext(dimension, { mode, minY, maxY, ceilingY })` signature.

- `mode` is `surface` (default, including the existing Nether/End profiles) or
  explicit `caves` (all natural enclosed interior faces).
- `minY <= blockY < maxY`; both bounds align to 16 blocks within the dimension.
- `ceilingY` is exactly an alias for `maxY`, without `+1`. Equal aliases normalize
  to the same context; conflicting aliases are rejected.
- Surface retains its dimension floor and previous defaults: Overworld -64..320,
  Nether 0..96 and End 0..256. A raised floor requires explicit caves mode.
- Caves initially accept thicknesses 16/32, default 32, and LOD 0/1. Bounds omitted
  in caves select the dimension's bottom 32 blocks. `CAVE_LIMITS` advertises these
  capabilities; unsupported thicknesses and LODs are rejected before generation.
- Canonical metadata also includes `ceilingY=maxY` for existing consumers.
  Dimension profile bounds remain separate from selected bounds and mesh extents.

```ts
const context = sceneContext("overworld", {
  mode: "caves",
  minY: -64,
  maxY: -32,
});
const bytes = await world.buildRegion({ ...context, level: 0, x: -1, z: 0 });
```

`openSceneWorld` still fixes its dimension. Surface and caves share the same
builder, database, palette and worker budget; a new pool per vertical window is
not required. The generic engine does not implement HTTP or disk cache policy.

## Geometry and appearance

Detailed regions allocate only the intersecting source sections plus vertical
and horizontal neighbor sections. A bounded source-section cache is shared across
depths. Voxel readers disable the surface-only depth shortcut and synthetic deep
rock filling for caves. Owner bounds apply before face emission, while real halo
blocks still determine occlusion and natural faces at the selected cut planes.
Solid rock at a cut does not create an artificial top cap.

L0 retains the existing models, lava flow flags, plants, water and glass. L1 uses
the existing one-block voxels. Larger LODs are excluded because they close narrow
passages. Cave biome tints sample the actual block altitude; L0 blends neighboring
columns at that altitude, while the coarse reader uses per-block source biomes.
Existing Surface/Nether/End paths retain their previous bytes.

The local viewer offers Surface/Caves, a 16/32 thickness selector and a vertical
slider. Rebuilding starts when the slider is released, not on every drag event.
URL state includes the canonical context and restores negative altitudes.
Cave focus stays in the selected window without settling onto a surface heightmap.
The view uses fixed neutral exploration lighting and a dark background.

## Resource ownership and limits

- Cave streaming starts at L1 and refines to L0, with a maximum 128-block radius,
  two concurrent browser requests and a 32 MiB quad-cache budget. Viewer options
  can lower the radius or change the cache budget. Above budget, stale entries
  are evicted and cave reach is reduced; drawn/fading terrain is not freed mid-frame.
- Empty-region metadata has a separate entry bound, so exploring absent chunks
  cannot accumulate unlimited zero-byte cache entries.
- Switching view aborts old requests and discards late responses. Previous
  streamers, colliders, arrays and geometry allocations are released.
- The renderer owns bounded mesh-shell pools (64 per material pair). Reused shells
  keep compatible shader state while old quad arrays and geometry buffers are
  released. Overflow meshes receive Object3D disposal as well as geometry disposal.
  All retained shells are disposed when their viewer is destroyed.
- Water retains its viewport depth and color nodes outside shader-building
  callbacks, avoiding new cached render targets on recompilation. Installed
  Three.js code and private renderer reset APIs are not modified.
- A compatibility wrapper for pinned Three 0.186 memoizes the setup results of
  its public screen-size/viewport singleton nodes. Their original per-render
  vector updates are preserved, including framebuffer resizing. A directional
  PCF filter retains its map-size/radius uniforms across shader builds;
  it uses the same five Vogel samples and weights as the installed stock filter.
  Its MIT attribution and license are retained in the source and the viewer's
  static `three-shadow-filter.LICENSE.txt` for minified distributions. These measures
  prevent shared binding-cache growth even when mesh shells are discarded.
- Local cave encoded results use a separate byte-bounded LRU, 16 MiB by default
  (`MAPELIX_CAVE_MEMORY_MIB`), and are not written to disk. Depth exploration cannot
  evict local Surface memory entries or grow cave disk variants. The local reader
  uses one worker per visited dimension by default (`MAPELIX_SCENE_WORKERS`).
- A local server process reads one fixed snapshot revision. Changing snapshots
  requires restarting that local process. Production revision replacement, the
  recommended separate 128 MiB cave disk quota and obsolete-revision deletion
  belong to a production server.

## Server contract

For a server other than the local adapter:

1. Accept signed bounds and the canonical context above. Preserve old defaults
   for metadata without `mode`/`minY`/`maxY`; retain the `ceilingY` alias.
2. Serialize caves as `dimension`, `mode=caves`, `minY`, `maxY`, plus the snapshot
   revision. Surface requests keep the legacy `dimension`/`ceilingY` query.
3. Region cache identity is snapshot revision + canonical context + LOD/X/Z. The
   generic helper keeps legacy Surface keys (`dimension/maxY/level/x/z`) and adds
   `dimension/caves/minY/maxY/level/x/z` for caves. Different strategies never
   share results merely because their bounds match.
   Include the generator revision in the namespace whenever mesh output changes.
4. Preserve configurable `regionBase`, `regionSuffix` (including `.bin`) and
   viewer options across `setWorld`. Binary region format remains **2**.
5. Advertise supported cave thicknesses/LODs, and version the host's own API when
   it exposes this interface, so older hosts can keep rolling back.
6. Implement independent Surface/caves cache quotas and preserve old-snapshot
   cleanup. Discovery indexes will later have their own snapshot/schema keys,
   independent of terrain windows, geometry strategy and LOD.

## Scope limits

This view shows minerals and other blocks where natural cave faces expose them;
it does not reveal every ore buried in solid rock. Discovery indexing and filters
remain later milestones. No interactive 3D selection box is included. Cave slicing
currently operates on reusable whole X/Z regions, without multiplying cache keys
by arbitrary selection rectangles.

The supplied real snapshot has no End chunks. End regressions and four-view GPU
lifecycle tests therefore use generated Bedrock data.

## Validation

The final checks passed on Windows with Node 24.14.1 and Three 0.186:

- Engine: **167 tests**, including existing dimension/region regressions, negative
  enclosed caves, exclusive bounds, altitude-dependent biome tints and shared
  Surface/caves builders.
- Viewer: **12 unit tests**, including abort/disposal, mesh reuse, canonical
  requests with a configurable base and `.bin` suffix, and independent cache budgets.
- Browser: **14 tests**, without failures, retries or skips, across normal GPU
  selection and forced WebGL 2. They include cave controls, release-only updates,
  URL restoration, framebuffer resizing, dimension navigation, models and lava.
- Builds and type checks passed. Lint has no errors; the engine reports two
  existing numeric-sort warnings in the unchanged foliage test.
- **39 legacy region byte comparisons** match the baseline. The real snapshot's
  14 source-file fingerprints remain unchanged.

Manual Chrome validation also passes on the real snapshot at two negative-Y
depths, with WebGPU confirmed and no browser errors. The example below centers
an underground chamber at X 7/Z 72 instead of solid rock near the original spawn.

Each backend completes **104 Surface/Caves/Nether/End switches** on generated
Bedrock terrain, using one renderer and checking equivalent End frames after fades
and garbage collection. At switch 52 the test disables mesh pooling, exercising
actual shader rebuilds and disposal as well as reuse. From switch 20 to 104:

| Backend              | Uniform buffers | Textures | JS heap          | Renderer allocation change |
| -------------------- | --------------- | -------- | ---------------- | -------------------------- |
| Normal GPU selection | 73 to 68        | 18 to 18 | 8.21 to 9.32 MiB | -52,727 bytes              |
| Forced WebGL 2       | 75 to 70        | 18 to 18 | 8.45 to 9.62 MiB | -47,581 bytes              |

The deliberately unpooled path warms additional shader state after switch 52.
Between switches 68 and 104, the heap difference is 315 KiB / 352 KiB, below the
512 KiB regression allowance; buffer, texture and renderer-byte counts are
identical at those endpoints. These are logical renderer allocations and live JS
heap measurements, not physical GPU residency. Retained renderer/shader caches
are expected; disposing the viewer removes its canvas and owned resources.

A separate run of the actual engine performs **1,040 view switches** on the real
snapshot, with one worker retaining at most three dimension builders. Reachable
heap at switches 104 and 1,040 is 11.55 and 11.66 MiB. In the second half it stays
within 11.49–11.69 MiB; process RSS fluctuates within 174.87–216.71 MiB. Native
allocation high-water marks and transient ArrayBuffer finalization differ from
reachable JS heap, so these numbers do not establish production VM headroom.

One real Overworld cave sample at X -1/Z 0, window [-64, -32), produces 22,428
bytes / 1,183 quads at L0 in 65.48 ms and 112,908 bytes / 6,675 quads at L1 in
181.07 ms. L1 covers a larger X/Z region. These are individual local observations,
not replacements for the concurrent/prewarming benchmarks approved in Milestone 0.

Full counters and checkpoints are in
[the measurement artifact](benchmarks/underground-m1-2026-11-13.json).

From the monorepo root:

```sh
pnpm turbo run build check lint test:unit --filter=@mapelix/scene-prototype --filter=@mapelix/prototype-viewer-3d
pnpm turbo run test:e2e --filter=@mapelix/prototype-viewer-3d
```

For installed Chrome, set `MAPELIX_TEST_BROWSER=chrome`. The browser tests create
their own disposable world; do not point test setup at a production world.
For manual exploration, start the local viewer with `MAPELIX_WORLD_DIRECTORY`
pointing at an extracted, read-only snapshot, then open:

```text
/?dimension=overworld&mode=caves&minY=-32&maxY=0&x=7&y=-16&z=72&distance=60&heading=56&pitch=60
```

Production quotas and deployment validation belong to each server.
