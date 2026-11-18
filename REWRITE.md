# Mapelix production rewrite ledger

## Purpose

The prototype proved that a pure TypeScript package can read a large Minecraft Bedrock world and
produce useful, dynamic, Leaflet-compatible tiles. The production rewrite should keep the proven
behavior while replacing prototype architecture where maintainability, memory use, or throughput
requires it.

This file is the durable handoff. Append decisions and measurements here as the rewrite moves
forward. Keep the original baseline unchanged so later results remain comparable.

## Frozen reference

- Monorepo: `mapelix`
- Archived prototype package: `@mapelix/prototype`
- Renderer baseline commit: `ee4275e` (`fix(core): match circuit and stone colors`)
- Baseline date: 2026-08-17
- Unit suite: 145 tests passing across 16 files
- Visual suite: 10 of 10 scenes passing
- Oracle: uNmINeD 0.20.1-dev, lossless PNG, zoom 2, 3D-opacity shadows, no block
  models, background `#78a7ff`
- Oracle and prototype outputs: `packages/mapelix-prototype/test/visual-regression/scenes`
- Scene definitions and gates: `packages/mapelix-prototype/test/visual-regression/manifest.json`

Run the frozen suite with:

```sh
pnpm test:visual
```

To score a new renderer, output `<scene>.png`, `<scene>-shadowless.png`, and
`<scene>-surface.json` for every scene, then run:

```sh
MAPELIX_VISUAL_CANDIDATES=/path/to/candidates pnpm test:visual
```

## Visual baseline

The headline similarity is **97.12%**. It is a macro-average across the 10 scenes:

```text
overall = mean(exact edge F1, shadow-mask F1, 1 - perceptual color error / 100)
```

This score is a regression summary, not a claim about every block in the world. Preserve the raw
signals below because one aggregate can hide a weak material or scene.

| Signal | Baseline |
| --- | ---: |
| Overall similarity | 97.12% |
| Exact structural-edge F1 | 94.52% |
| One-pixel-tolerant edge F1 | 97.07% |
| Shadow-mask F1 | 97.47% |
| Shadow-loss correlation | 97.72% |
| Mean perceptual block-color error | 0.628 |
| Derived block-color similarity | 99.37% |
| Native-tile alignment | 0,0 in all 10 scenes |

### Per-scene scores

| Scene | Exact edge | Tolerant edge | Shadow F1 | Shadow correlation | Color error | Alignment |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| village-roofs | 99.44% | 99.99% | 99.14% | 99.38% | 0.248 | 0,0 |
| snow-mountain | 97.94% | 99.33% | 99.19% | 99.50% | 1.227 | 0,0 |
| forest-coast | 96.61% | 99.43% | 99.14% | 98.94% | 1.374 | 0,0 |
| dark-canopy | 93.93% | 98.84% | 98.25% | 98.07% | 1.516 | 0,0 |
| flat-grass-shore | 87.94% | 90.54% | 87.41% | 89.22% | 0.248 | 0,0 |
| highland-legacy-grass | 98.78% | 99.72% | 99.05% | 98.95% | 0.405 | 0,0 |
| redstone-array | 98.65% | 99.79% | 99.87% | 99.77% | 0.360 | 0,0 |
| stone-coast | 94.91% | 98.96% | 98.96% | 99.25% | 0.666 | 0,0 |
| dry-biome-boundary | 90.06% | 95.21% | 93.82% | 94.26% | 0.055 | 0,0 |
| technical-array | 86.96% | 88.89% | 99.90% | 99.85% | 0.180 | 0,0 |

### Production parity gate

The rewrite reaches prototype parity when all conditions are true on the same revision:

1. All 10 committed scene gates pass without changing the uNmINeD oracle.
2. Native-tile alignment is `(0,0)` for every scene.
3. Macro exact-edge F1 is at least 94.52%.
4. Macro shadow-mask F1 is at least 97.47%.
5. Mean perceptual block-color error is at most 0.628.
6. The overall score is at least 97.12%.
7. The unit and tile-boundary suites pass.

An intentional rendering improvement can replace a prototype baseline only after a lossless oracle
comparison shows the gain. Record the old and new signals in this ledger.

## Performance and memory baseline

These runs answer different questions and must not be compared as if they used the same workload.
See `OPTIMIZATIONS.md` for the complete history and rejected experiments.

| Workload | Workers | Cold index | Render | Peak RSS | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| Eight-scene renderer run | 8 | 45.64 s | 4.17 s cold; 3.39 s repeated | 3.63 GiB | 1.92 cold and 2.36 repeated tiles/s; about 8.7 effective CPU cores. |
| Directional-shadow-halo diagnostic | 2 | 38.63 s | 3.18 s mean for one normal and one shadowless tile | 1.38 GiB | Includes the 256-block northwest shadow input halo. |
| Viewer Playwright run | 8 | Included in run | 1.2 min cold; 12.3 s warm | Below 4 GiB renderer RSS | Fresh and warm disk-cache paths both passed. |

Production measurements must record the world hash or fixture, worker count, Node version, cache
state, elapsed time, peak RSS, retained heap after GC, and tiles per second.

## Behavior to preserve

- Keep the reusable package programmatic. HTTP, Leaflet, Canopy, and disk caching are adapters.
- Keep Bedrock decoding independent from Node.js where byte-oriented code can remain portable.
- Read LevelDB table and log records with last-write-wins and tombstone behavior.
- Decode legacy and palette subchunks, negative Y, Data2D, and Data3D biomes.
- Ignore inventories, actors, block entities, and unrelated records in the terrain index.
- Preserve visible vertical runs for water, glass, foliage opacity, and shadow casting.
- Preserve standard XYZ PNG output and exact negative-coordinate floor behavior.
- Preserve configurable render concurrency with bounded memory.
- Keep uNmINeD parity as the default. Put corrections to known reference bugs behind an explicit
  option until the production style intentionally diverges.
- Keep the PNG disk cache in the consuming server. The core package owns deterministic tile data.

## Rewrite workstreams

| Workstream | Status | Completion signal |
| --- | --- | --- |
| Freeze prototype evidence | Complete | Oracle, surfaces, thresholds, scores, and benchmark history are committed here. |
| Define production module seams | Pending | Public API and ownership boundaries are documented before implementation. |
| Build the byte and LevelDB layer | Pending | Format tests pass without renderer or filesystem coupling. |
| Build the compact world index | Pending | Large-world retained heap and cold-index time meet recorded targets. |
| Build surface extraction | Pending | All XYZ-aware material, biome, water, and vertical-run tests pass. |
| Build the renderer | Pending | The 10-scene production parity gate passes. |
| Add worker lifecycle and scheduling | Pending | Configurable concurrency has clean shutdown, bounded queues, and measured scaling. |
| Add Canopy and server adapters | Pending | Changed chunks invalidate the correct tiles without coupling the core to the server. |
| Release hardening | Pending | API docs, compatibility policy, packaging, CI, and representative real-world soak tests pass. |

## Decision and measurement log

Append entries. Do not rewrite earlier results.

| Date | Area | Decision or experiment | Evidence | Result |
| --- | --- | --- | --- | --- |
| 2026-08-17 | Baseline | Freeze `ee4275e` as the production rewrite reference. | 145 unit tests and 10 lossless visual scenes; 97.12% aggregate similarity. | Accepted |
| 2026-08-17 | Repository | Archive the completed implementation and its dependants inside the Mapelix monorepo; reserve `@mapelix/core` for production work. | Prototype behavior and evidence remain runnable as `@mapelix/prototype`. | Accepted |
| 2026-09-23 | LevelDB | In the 3D scene prototype, open tables by their footer and index block and inflate only the data blocks a lookup needs. | The 556-table, 1.1 GB Amelix database opened in 0.5 s with a warm file cache and 167 MiB RSS, and one chunk lookup took 1.9 ms. The archived full index scan took 45.64 s. A fixture test matches a full scan for every chunk. | Prototype evidence |
| 2026-09-23 | Biomes | In the 3D scene prototype, read Data3D storage `i` as subchunk `i - 4` and treat header `0xff` as a copy of the storage below. | On 683 sampled Amelix chunks, 4,416 of 365,312 voxel lookups that the archived decoder left empty now return a biome. Six lookups in one chunk with a missing subchunk return a different biome. | Open: confirm the layout before changing the archived decoder |
| 2026-09-23 | Levels of detail | In the 3D scene prototype, build levels 1 to 5 as cubic voxel levels that merge each 2×2×2 group into one voxel, upper half first, following Voxy. | On Amelix, floating platforms and towers keep their shape from 300 to 1400 blocks away. Level 1 draws 1.9 times the opaque quads of the column levels, and levels 2 to 5 draw 0.8 to 1.2 times. The viewer draws 320 fps at spawn zoomed out and 358 fps at the far village, against 335 and 400 fps for the column levels. With eight workers, a cold level 3 region takes 2.2 s and a level 5 region 16 s, against 1 s and 6 s. | Prototype evidence |
| 2026-09-23 | Levels of detail | In the 3D scene prototype, count a block as ground only at the top of 4 solid blocks, so the level reader keeps reading under thin floors and platforms. | A witch farm of 1-block floors over missing subchunks drew as solid pillars at levels 1 and up, and now keeps its open air. Over 12 benchmark regions, build time rose 3 to 7% and quads rose 0.3 to 1.2% per level. The farm's own level 1 region gained 49% for its visible floors. | Prototype evidence |
| 2026-09-23 | Levels of detail | In the 3D scene prototype, pick each region's level by the size of its voxels on screen, as Voxy does, and switch to finer voxels before they grow past 2.2 pixels at the region's nearest point. | At 1440×900 on an RTX 2070, four far views draw 4.2 to 13.5 M quads at 173 to 315 fps and hold 49 to 156 MiB of quads. The previous rule, equal to 4.4 pixels at that size, drew 1.3 to 4.3 M quads at 294 to 415 fps. A 1.5-pixel target draws 7.5 to 22.8 M quads at 118 to 261 fps. | Prototype evidence |
| 2026-09-23 | Camera | In the 3D viewer prototype, cast camera and pointer rays against the drawn quads. Put the orbit point on the first surface in view when a drag, wheel step, or key press starts, zoom toward the surface under the cursor, and keep the camera out of blocks by sweeping each move against the quads, sliding along floors and ceilings and climbing walls. | At the Amelix witch farm, the orbit point keeps its height through a pan, and wheel zoom reaches the open air between the tower's floors at y 84; the height rule kept the camera above the tower's top. Tile boxes from the height map let a ray skip regions it passes over. In Chrome, a raycast takes 0.1 to 0.3 ms on average; the first ray over new terrain takes up to 14 ms while its quads are sorted into tiles. | Prototype evidence |
| 2026-11-16 | 2D lifecycle | Add graceful and aborting `BedrockWorld.close()`, drain accepted work, and release idle workers and retained records. | 169 prototype unit tests, including 11 child-process lifecycle cases; unchanged sampled snapshot PNGs and 10 archived visual scenes. Two-worker abort cleanup took 2.84 ms after a 100 ms render interval on the local small snapshot. | Validated; pending review |
| 2026-11-16 | 2D lifecycle review | Accept the lifecycle prerequisite and commit it as `b4198f9`. | Maintainer also reports 169 2D and 64 viewer tests passing on Linux with no remaining process. | Accepted; not pushed |
| 2026-11-16 | 2D dimension profiles | Introduce `@mapelix/core` profile metadata and a Node adapter over the reference renderer. Apply physical dimension bounds and an included Nether `topY=90`, including shadow inputs and fixed Data3D slots; keep reference defaults and 3D unchanged. | 32 core, 179 reference, 182 scene and 64 viewer unit tests; 8 targeted browser cases; 6 unchanged 3D fixture payloads and 6 unchanged legacy snapshot PNGs. A one-worker Node 24.14.1 run renders 8 Nether zoom-0 tiles in 6.18 s at 372.2 MiB peak RSS and 17 Overworld tiles in 27.96 s at 530.6 MiB; OS cache uncontrolled. End coverage uses generated fixtures. | Validated; pending review |
| 2026-11-16 | 2D dimension review | Accept batch 1 and commit it as `0008729`, excluding generated Turbo output. | Maintainer independently reports 179 reference, 32 core, 182 scene and 64 viewer tests, build/check/lint and process cleanup passing on Linux. | Accepted; not pushed |
| 2026-11-16 | Shared appearance and classic 2D | Move the existing sampled catalog and tuned color/alias resolver to portable `@mapelix/core/appearance`; retain scene compatibility exports and common biome definitions. Derive state/axis-aware 2D profiles with top-face, ground-cover and classic transparency rules; keep explicit reference appearance. | 500 unit tests, 8 targeted browser cases and 10 archived scene gates pass. All 4,461 3D appearance cases, 6 region payloads, 25 reference-profile snapshot PNGs and 6 original-prototype PNGs are unchanged. Modern concurrency-1 main-process runs render 17 Overworld tiles in 28.96 s at 537.1 MiB peak RSS and 8 Nether tiles in 6.28 s at 380.7 MiB; OS cache uncontrolled. Bed dye metadata from block entities remains a documented 2D reader gap. | Validated; pending review |

| 2026-11-16 | Shared appearance review | Accept batch 2 and commit every reviewed source, test and documentation file as `f44fdf0`. | Maintainer independently reports 185 reference, 68 core, 183 scene and 64 viewer tests, build/check/lint and process cleanup passing on Linux; prototype/core/scene dependencies have no cycle. Block-entity bed dyes remain a later 2D reader follow-up. | Accepted; not pushed |
| 2026-11-16 | Bounded classic 2D export | Add `@mapelix/core/node/batch` and the generic `@mapelix/render-cli` consumer: sparse native planning, worker/pending/tile/input/output/time/sampled-RSS limits, source and engine fingerprints, verified immutable payloads and atomic version-1 publication. Keep all serializable reference render options in the worker pool; opt into a worker at concurrency one. | 557 unit tests, 8 targeted browser cases and 10 archived visual gates pass on Windows/Node 24.14.1. All 4,461 3D appearance cases, 6 region payloads and 25 real-snapshot PNGs at both worker counts are unchanged. Complete zoom-0 exports, including hashing/indexing/writes, take 28.66 s / 587.7 MiB for 17 Overworld tiles with one worker and 15.64 s / 1029.6 MiB with two; 8 Nether tiles take 7.06 s / 487.1 MiB and 4.07 s / 775.6 MiB. OS cache uncontrolled; heap after close/GC is 7.9 MiB. Cancellation, coordinator crash, publication failure and memory/deadline exits release owned resources. New/changed-file formatting passes; global legacy format checks retain pre-existing findings. | Validated; pending review |
| 2026-11-16 | Bounded export review | Accept batch 3 and commit it as `2f08785`. | Maintainer independently reports 190 reference, 108 core, 12 CLI, 183 scene and 64 viewer tests, build/check/lint and process cleanup passing on Linux. Hosts own generation retention and stale-lock recovery after a hard kill. | Accepted; not pushed |
| 2026-11-16 | Classic 2D overview zooms | Add overview zooms -4..-1 composed directly from zoom-0 PNGs with an integer premultiplied-alpha area filter, sparse floor-division coverage, hidden temporary sources counted in batch limits, and optional manifest `grid.overview`/`work` fields. Native rendering and defaults are unchanged. | 191 reference, 144 core, 12 CLI, 183 scene and 64 viewer unit tests; 240,976 overview seam pixels with zero mismatches; native PNGs, 4,461 3D appearance cases and the six-region 3D samples unchanged. Profiling in [`docs/2d-performance.md`](docs/2d-performance.md): the full Overworld export takes 151.3 s against 12.9 s for the reference renderer with matched opacity shadows; the shadow halo dominates. | Validated; pending review; performance follow-up proposed |
| 2026-11-16 | Classic 2D export caches | Reuse extracted chunk surfaces (including full-height opacity runs) and parsed database records across tiles and native zooms inside a bounded per-renderer `renderCacheMiB` budget; order native batch tiles by zoom-0 area into per-lane bands and send each job to the nearest idle worker. Output unchanged. | 194 reference, 146 core, 12 CLI, 183 scene and 64 viewer unit tests; every PNG of the full Overworld and Nether exports byte-identical; 4,461 3D appearance cases and the six-region 3D samples unchanged. Full Overworld export 151.4 s → about 14.5 s, Nether 34.3 s → about 5.3 s ([`docs/2d-performance.md`](docs/2d-performance.md)). | Accepted; committed as `7457665` |
| 2026-11-16 | Incremental classic 2D updates | Store per-chunk fingerprints of effective map records in each generation (`source-chunks.json`); with `incremental: true` / `--incremental`, re-render only native tiles whose dependency bounds (surface input with the 256-block shadow halo, biome-blend window) intersect a changed, deleted or new chunk, recompose overviews above affected zoom-0 tiles, and copy the rest after digest checks. Full-render fallback with a reason when renderer, resources, grid or settings differ. | 194 reference, 152 core, 12 CLI, 183 scene and 64 viewer unit tests; dependency marking equals a brute-force scan; three simulated updates of the local snapshot produce the same generation as full renders; default PNGs, 4,461 3D appearance cases and six-region samples unchanged. Unchanged Overworld 3.4 s, unchanged Nether 2.0 s; updates 11.9–14.6 s against 15.2 s for a full render ([`docs/2d-performance.md`](docs/2d-performance.md)). | Accepted; committed as `f217d04` |
| 2026-11-16 | Persistent chunk surface cache | Optional `surfaceCache` / `--surface-cache[=<mib>]`: keep extracted chunk surfaces in bounded, verified packs below the owned output root, keyed by chunk fingerprint, renderer revision and settings (dimension, cut, style, biome blend). Renderers read packs; the coordinator writes them once on a clean close and drops stale entries, damaged packs and other namespaces. A missing or damaged cache only causes re-extraction. | Same generation with and without the cache for three simulated updates; every tile equals the batch-5 full renders; damaged-cache and link refusal tests. Updates of 20 / 400 / 170 chunks: 6.9 / 9.4 / 11.7 s instead of 11.8 / 12.1 / 14.7 s; warm full render 9.5 s ([`docs/2d-performance.md`](docs/2d-performance.md)). | Accepted; committed as `7830060` |
| 2026-11-16 | Isometric 3D camera | Add an isometric (orthographic) projection to the 3D viewer, blended from the unchanged perspective camera so the plane through the focus keeps its scale during a 0.6 s animated switch. Picking, wheel zoom and mouse drags cast parallel rays from the near plane, which lies behind the camera in isometric view so ground below the focus stays drawn at low tilt; LOD refines by projected cell size inside the view; water depth uses the inverse projection; shadows cover the isometric footprint; clouds fade out; the rain volume follows the focus and grows with the zoom to cover the visible ground. Regions stored while the view was isometric do not change perspective levels of detail, so returning to perspective matches a view opened directly in it. Expose CSS pixels per block on the focus plane (2D map zoom `z` is `2^z` px/block), a toolbar toggle, `projection=iso` links, optional automatic-perspective rules (deep zoom, low tilt; off by default) and a `?demo=projection` panel. | 80 viewer unit tests (16 new: blend 0 equals the old matrix, blend 1 equals an orthographic camera, focus-plane scale and far depth kept, isometric near plane behind the camera, parallel rays land under the pointer, perspective region requests identical, isometric LOD by scale, same regions after an isometric round trip, perspective rain volume unchanged). 5 new browser tests: shallow water shows its bed in perspective and isometric views; a perspective frame after a round trip is pixel-identical to a direct one; a mouse drag moves perspective and isometric views by the same ground distance. All 4,461 3D appearance cases and six-region samples unchanged. | Accepted; committed |
| 2026-11-17 | 3D engine package | Move the 3D engine from `apps/prototype-viewer-3d/src/lib/viewer` to the new browser package `@mapelix/viewer` (`packages/mapelix-viewer/src/three`, exported as `@mapelix/viewer/three`) so other apps can embed it. 41 files renamed without changes; the prototype imports the package. | 4,461 3D appearance cases and six-region samples unchanged; 80 unit tests and the 3D browser suite pass; Linux build/check/tests pass. | Accepted; committed |

| 2026-11-17 | 3D block textures | Host-provided Bedrock packs (a stack folder with `mapelix-stack.json`, or a pack list) feed a 16-pixel atlas with copied gutters and mipmaps down to 4-pixel tiles, served Brotli/gzip under an immutable texture revision kept apart from the world revision. Level 0 Surface regions get a textured variant (one more word per quad); the viewer, off by default, swaps near regions for it and blends each pixel from block color to texture between 4 and 8 CSS pixels per block, measured from the projection. Overlay textures (grass sides) keep their alpha as a color mask. Embed API 5, compatible with version 4 hosts. | 208 scene and 155 viewer unit tests; vanilla atlas 1,883 tiles, 5.46 MiB on the GPU, 629 KiB Brotli / 824 KiB gzip transferred; textured regions cover 99.8% of quads with the same quad count and 1.31 times the bytes; peak RSS 146 MiB to check the stack, 193 MiB to build regions, 531 MiB for the whole dev demo. WebGPU and WebGL 2 render in perspective and isometric without tile bleeding. Emulated phone (375×812, DPR 3, CPU ×4, desktop GPU): same frame rate with and without textures; no real phone GPU measured. | Prototype evidence; pending review |
| 2026-11-18 | Fast and detailed leaves | Transparent texels of cut-out cubes such as leaves take half the leaves' tint by default (`fast`: opaque, no extra faces). `detailed` cuts them out from a separate `cutout=1` region variant that also draws the faces inside foliage. Thin cut-out shapes such as leaf litter always cut out and never hide the face below; leaf litter takes its own color; rotated textures on lying logs no longer turn black. | 209 scene and 156 viewer unit tests. Dense forest: detailed regions hold 2.07–2.1 times the quads and bytes of fast ones (region −2,3: 20,974 → 43,941 quads, 350 → 709 KiB); same frame rate with both modes, desktop and emulated phone, on a desktop GPU. New browser test: with textures off, frames are pixel-identical to a server without textures, in WebGPU and WebGL 2, perspective and isometric; a one-off comparison against `main` gave identical SHA-256 frames for 12 Overworld, Nether and End views. | Prototype evidence; pending review |
| 2026-11-18 | Weathered copper shapes | Lanterns, bars and chests in copper at every oxidation stage, waxed or not, take the lantern model, the bars pane model and the chest box like their plain forms instead of a full cube; plain `copper_bars` was a full cube too. This changes the untextured rendering of these 22 blocks only. | 221 scene unit tests (new: every copper stage matches the plain shape; sea lanterns, jack o'lanterns and copper blocks stay cubes). 66 of the 4,461 3D appearance cases change, all on those 22 blocks (3 states each); the other 4,395 are unchanged. | Validated; pending review |
| 2026-11-18 | Texture stack changes while running | `SceneServer.setTextures(source \| null)` replaces the texture stack without a restart: the packs are read and the atlas built first, a stack that cannot be read or built leaves the current one and comes back as a `validateTextureStack` report, then the new revision is served, the previous atlas and textured regions leave the disk (writes still finishing are dropped), and a prewarm that reached the textured regions restarts them. Changes run in turn. The viewer reads `world.json` again on a 409 textured region, a failed atlas or the page showing again (at most every 5 s), or on `MapelixViewer.refreshWorld()`, and takes the new revision without reloading. The demo gets an opt-in `/textures` page (upload, vanilla download, removal); Mapelix itself has no upload route. Region format 2 and embed API 5 unchanged; the new methods are optional. | 158 viewer and 221 scene unit tests (new: replacement, refusal, same stack, turn order, removal, prewarm restart, disk cleanup; textured regions dropped at once with their atlas; 409 reported as stale). Dev demo on the read-only world copy: vanilla 7eaa6e83… → synthetic pack 207423df… while a map was open, picked up after one 409; removal leaves no atlas or textured region on disk; a broken upload answers 422 and keeps the pack. Textures-off browser test passes (WebGPU and WebGL 2, perspective and isometric); demo browser suite 47 passed, and the phone pinch case of `switch.e2e.ts` fails the same way with the viewer code of `main` (2.19 px/block after the pinch, under 2 expected). | Validated; pending review |
| 2026-11-18 | Textures in the Caves view | Level 0 cave slices get a textured variant (`?mode=caves&…&textures=`, and `cutout=1`), built on demand like plain slices, even by a cache-only handler, in their own cache `<cache>/textures/caves/` with the cave cache sizes; it follows stack changes like textured Surface regions. The streamer asks for it in Caves too, and the textures and detailed-leaves switches stay available there. Region format 2 and embed API 5 unchanged. | 159 viewer unit tests (new: textured and detailed cave slices built apart and remembered; cache-only handler builds textured slices; cave streamer sends the slice with the texture revision). Dev demo, read-only world copy, vanilla pack: the 32–64 slice under the village draws four textured slices with the switch enabled. | Validated; pending review |
| 2026-11-18 | Skipped pack images, demo pack stack | An image over the limits or damaged (size, CRC, decode) is skipped alone instead of refusing the stack: the next pack's image takes its place, the stack fingerprint covers every candidate file and the image limits, and reports list `skipped` (pack, file, reason) with a `textures.images-skipped` event; a pack that changes while read still refuses the stack. The demo manages a stack, highest priority first: upload on top, vanilla at the bottom, reorder, drop; the controls take a `texturesLink` to its page. Region format 2 and embed API 5 unchanged. | 223 scene prototype and 159 viewer unit tests (new: a skipped image falls back to the next pack, larger limits keep it and name another stack, a cut image refills its frames from the next pack, the server reports and logs skipped images). A third-party high-resolution pack over vanilla: accepted, 1,045 images from it, `lava_flow.png` and `water_flow_grey.png` (512 × 16,384) taken from vanilla; dev demo upload, reorder and settings link checked in the browser. | Validated; pending review |

## Open production questions

- Follow-up: in the isometric 3D view, selection handles still pick with a perspective ray, and
  discovery markers behind the camera plane can show. Both work in perspective.
- Follow-up: two 3D browser tests sometimes time out while terrain loads during a full WebGL run
  and pass when run alone: `cave-navigation.e2e.ts` "held keyboard ascent follows depth without
  changing zoom/angles; manual preference survives reload" and `discovery-focus.e2e.ts` "Surface
  excludes coarse or missing heights and updates cached discoveries when exact terrain arrives".
- Follow-up: read optional Bedrock block-entity bed dyes in the 2D snapshot adapter. Reuse the shared
  16-color catalog; palette-provided dyes already work. Keep this reader extension separate from
  the batch exporter and preserve malformed/stale metadata handling when it is implemented.
- Should the persistent index use packed typed arrays, a native accelerator, or both behind one
  interface?
- What is the invalidation contract between Canopy events, changed chunks, shadow halos, and
  biome-blend neighbors?
- Which texture-pack or resource-pack behavior belongs in the first production release?
- Follow-up: textured block models. Models take their texture from world coordinates, which
  suits fences, walls, stairs and doors; anvils, grindstones, lightning rods, lecterns and other
  detailed blocks still draw as full cubes, lanterns, torches, chains, end rods and flower pots
  use sprite-sheet textures that need per-face texture rectangles, and beds use entity textures.
- Follow-up: far block colors (2D map and coarse 3D levels) could derive from the host's texture
  stack instead of the built-in catalog; postponed.
- Follow-up: lava, water and glass keep their own materials with textures on, and block models
  with a fixed color part (walls, some fences) stay untextured.
- Which known uNmINeD quirks stay available as compatibility flags after the default style evolves?
- What memory and latency budgets should become release gates for one, four, and eight workers?
