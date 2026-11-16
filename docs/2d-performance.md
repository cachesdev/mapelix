# 2D export performance

This page records how long a classic 2D export takes today, where the time goes, and the proposed
follow-up. All numbers come from one small local Bedrock snapshot (Overworld and Nether, no stored End
chunks) on a desktop Ryzen 7 7800X3D with Node 24.14.1. The OS file cache was not controlled. Treat
them as relative observations, not release budgets.

## Baseline

Fresh process and output, compiled CLI, two rendering workers, default output (opacity shadows):

| Dimension | Zooms   | Tiles | Elapsed  | Peak RSS   | Overview composition |
| --------- | ------- | ----: | -------: | ---------: | -------------------: |
| Overworld | 0       |    17 |  15.59 s | 1019.5 MiB |                    — |
| Overworld | -4..0   |    36 |  16.18 s | 1007.9 MiB |             0.290 s |
| Overworld | -4..+2  |   376 | 151.32 s | 1018.1 MiB |             0.297 s |
| Nether    | 0       |     8 |   4.18 s |  758.5 MiB |                    — |
| Nether    | -4..0   |    24 |   4.44 s |  756.4 MiB |             0.179 s |
| Nether    | -4..+2  |   184 |  34.43 s |  772.8 MiB |             0.159 s |

The same Overworld export with shadows disabled takes 25.29 s (376 tiles, 717.9 MiB peak RSS).
Shadows therefore account for about 126 s of the 151 s.

## Reference renderer on the same snapshot

The reference renderer was run on a fresh copy of the same snapshot, one chunk processor, zooms
-4..+2, PNG output:

| Dimension | Shadows               | Elapsed  | PNGs |
| --------- | --------------------- | -------: | ---: |
| Overworld | `2d` (height shading) | 10.82 s  |  607 |
| Overworld | `3do` (opacity)       | 12.89 s  |  607 |
| Nether    | `2d`, top Y 90        |  7.36 s  |  352 |
| Nether    | `3do`, top Y 90       |  6.44 s  |  352 |

With matched opacity shadows, Mapelix is about 12 times slower on the Overworld. The reference
renderer also writes some fully empty native tiles (28 at zoom 0 against 17), so tile counts differ
while the 19 overview tiles match.

## Where the time goes

A dense diagnostic profile (timers in every worker, about 50 % overhead, so not a baseline) shows:

- **Native zooms are rendered independently.** Zoom 0, +1 and +2 each read the world again. Every
  tile builds a fresh decoded record set; there is no cache across tiles or zooms.
- **The shadow halo dominates.** A tile requests a 256-block north/west halo plus one border block.
  The input grid is 513, 385 and 321 columns wide at zoom 0, +1 and +2, about 4, 9 and 25 times the
  visible core area. Halo surface extraction takes about 24, 71 and 223 cumulative worker-seconds at
  zoom 0, +1 and +2, against about 9 s per zoom for the visible core. The halo is about 65 % of the
  cumulative worker time.
- **The same data is decoded many times.** The Overworld has 15,794 distinct stored subchunks but
  the export performs 617,915 subchunk decodes, about 39 per subchunk (60,919 / 143,967 / 413,029 by
  zoom). The Nether shows about 31 decodes per subchunk.
- **Other stages are small.** Cumulative LevelDB parsing is 3.4 / 9.8 / 31.6 s, subchunk decoding
  2.4 / 5.1 / 15.0 s, the direct shadow pass 1.6 / 4.5 / 5.4 s and PNG encoding 0.1 / 0.4 / 1.3 s.

Profiling hooks were observational: every profiled export produced PNGs byte-identical to the
unprofiled exports.

## Proposed follow-up (batch 4b)

Goal: the default Overworld export of this snapshot in at most twice the reference renderer's
height-shading time (≤ 21.6 s), with byte-identical reference PNGs, a stated worker budget and
repeated warm and cold measurements.

1. Reuse decoded records, chunks, biome and style data, surfaces and full-height opacity runs across
   neighbouring native tiles and across zooms 0..+2, inside an explicit cache byte budget keyed by
   snapshot, dimension, height cut, appearance and biome settings.
2. Schedule native tiles spatially so that neighbouring tiles share one worker and its cache.
3. Stop rereading and inflating the selected LevelDB files for every native tile.
4. Keep resolution-dependent shadow sampling and shading exactly: no resizing of +2 into lower
   native zooms, no smaller default halo, no change to opacity math.
5. Optionally, and only if approved, add a lighter shadow mode with explicitly different quality.
   It must never change the default PNG reference set.

Incremental rendering (batch 5) is a separate goal. It must invalidate on real per-dimension
dependencies, including shadow-halo and biome-blend neighbours. A useful order of magnitude: a
single-core incremental update of a larger world with the reference renderer redrew 4,805 changed
Overworld chunks and kept 672 unchanged tiles in 57 s, and checked an unchanged Nether in 4 s.
