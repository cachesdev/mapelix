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

## Open production questions

- Should the persistent index use packed typed arrays, a native accelerator, or both behind one
  interface?
- What is the invalidation contract between Canopy events, changed chunks, shadow halos, and
  biome-blend neighbors?
- Which texture-pack or resource-pack behavior belongs in the first production release?
- Which known uNmINeD quirks stay available as compatibility flags after the default style evolves?
- What memory and latency budgets should become release gates for one, four, and eight workers?
