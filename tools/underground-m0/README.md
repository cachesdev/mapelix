# Underground Milestone 0 measurement tools

Experimental tools based on `e02cf7c`. They do not implement a public API or change
any server, production world or shipped viewer.
Generated engine copies, fixtures, region files, Chrome profiles and measurements
stay below the ignored `.local/` directories of this checkout.

These archived scripts require the unmodified engine and viewer at `e02cf7c`.
To reproduce Milestone 0, use a disposable checkout of that revision and copy only
`tools/underground-m0` from this branch into it, then run the commands below there.
The scripts intentionally depend on baseline source anchors; do not run their
experimental transforms against the Milestone 1 engine. To validate the current
implementation, use the normal tests in the
[Milestone 1 notes](../../docs/underground-rendering.md).

Use a disposable extracted snapshot. The reader opens database files read-only;
the measurement scripts fingerprint all source files before and after the CPU runs.
The End lifecycle scene is a generated Bedrock catalog, because the measured real
snapshot has no End chunks.

From the repository root, with Node 24 and pnpm 11 selected:

```powershell
$env:MAPELIX_M0_WORLD_DIRECTORY = 'D:\path\to\disposable-world-copy'
pnpm turbo run build --filter=@mapelix/scene-prototype
node tools/underground-m0/setup.mjs
node tools/underground-m0/validate.mjs
node --expose-gc tools/underground-m0/bench.mjs --run
node tools/underground-m0/prepare-views.mjs
node --expose-gc tools/underground-m0/load.mjs
node --expose-gc tools/underground-m0/server-lifecycle.mjs
```

Run CPU benchmarks separately from browser measurements. `bench.mjs` uses one
worker per case, one first/cold application-cache build and ten additional builds.
It discards the first two additional builds and reports median/p95 of eight.
The operating system's filesystem cache is not purged. RSS includes the controller
and worker in the same Node process, not only the voxel arrays.

`load.mjs` is an independent local scheduling/cache simulation. It shares a bounded
worker budget and coalesces identical requests. Foreground jobs outrank queued
prewarm jobs, while an already-running prewarm job is allowed to finish. Its small
8 MiB disk / 2 MiB encoded-memory cache partitions deliberately force eviction.
It is not an implementation or test of `apps/scene-server`.

`server-lifecycle.mjs` checks repeated view switches with one worker and at most
three dimension builders. It requests garbage collection at equivalent checkpoints
and reports worker heap/ArrayBuffer accounting separately from process RSS. The real
End is empty. To repeat the extended allocator plateau check:

```powershell
$env:M0_SERVER_SWITCHES = '1040'
node --expose-gc tools/underground-m0/server-lifecycle.mjs
```

This is not a server pool lifecycle test or a production latency benchmark.

## Browser lifecycle experiments

The Windows browser tools require installed Chrome, PowerShell/CIM process metrics
and unused local ports 5199/5200. They use isolated Chrome profiles. Only test
Chrome descendants contribute to process-memory totals. No other browser process
is killed or measured. Normal port 5173 and other worktrees are not used.

First measure the unchanged viewer:

```powershell
$env:M0_CLEANUP_FIX = '0'
$env:M0_WATER_FIX = '0'
$env:M0_MESH_POOL = '0'
node tools/underground-m0/browser-loop.mjs
```

Then measure the experimental lifecycle corrections:

```powershell
$env:M0_CLEANUP_FIX = '1'
$env:M0_WATER_FIX = '1'
$env:M0_MESH_POOL = '1'
$env:M0_BACKENDS = 'auto,webgl'
node tools/underground-m0/browser-loop.mjs
node tools/underground-m0/browser-direct.mjs
```

Each backend performs 104 consecutive Surface/Caves/Nether/End switches with one
renderer and canvas. Terrain must actually load before a sample. The lifecycle
test uses precomputed real-world region bytes and a generated End scene; it does
not pretend to implement the future caves transport or camera UX.

The experimental viewer changes are injected by the harness/Vite transform:

- Dispose rendering objects as well as geometries when objects are discarded.
- Retain a single water viewport-depth node outside shader-building callbacks.
- Reuse a bounded set of compatible mesh objects to avoid an expanding shared
  compilation/binding cache. Pool capacity is 16 objects per material pair. Old
  geometry GPU allocations are disposed and old quad arrays are cleared.

No installed Three.js source or tracked viewer source is patched. The direct CDP
control never enables the Network domain, avoiding the debugger's response-body
cache when interpreting Chrome process RAM. It uses the same bounded pool and
water-depth correction as the Playwright experiment. The entire renderer/device
is destroyed at the end.

GPU counters describe live logical renderer resources, not measured physical
VRAM residency. Chrome private bytes and summed working sets include browser,
JIT, driver and OS caches; summed working sets may count shared pages more than
once. Compare equivalent warmed views and do not confuse these measurements
with a promise that Windows immediately returns all memory to the OS.

The prototype deliberately retains the existing column-based biome tint lookup.
Altitude-correct cave-biome blending and the final camera/API are later work.
The M0 interface is not a stable engine API. See the decision report for limits.
