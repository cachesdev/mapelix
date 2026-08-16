# Mapelix Optimization Log

Mapelix is an experiment harness. Its implementation can be replaced, but measured findings from it should carry into the production renderer.

## Reference workload

- World: copied Stratos `TMBcraft - pruned v2`
- LevelDB size: about 622 MB in 342 database files
- Overworld data: 831,012 live block subchunks across 1,580 map tiles
- Reference tile: densest zoom-zero tile at `x=-13`, `y=-12`, containing 1,548 subchunks
- Runtime: Node.js 24 on WSL2

Run the tracked benchmark from the repository root:

```sh
MAPELIX_BENCH_WORLD=/tmp/mapelix-stratos-tmbcraft-pruned-v2 \
MAPELIX_BENCH_WORKERS=1 \
MAPELIX_BENCH_TILES=1 \
pnpm turbo run benchmark --filter @mapelix/core
```

Timing can vary with the filesystem cache. Compare repeated experiments in the same WSL session and use the JSON data rather than Turbo's total duration.

## Successful optimizations

| Change | Index | First tile | Repeated tile | Peak RSS | Transferable finding |
| --- | ---: | ---: | ---: | ---: | --- |
| Bulk values to a block-only lazy index | 34.04 s | 2.59 s | 1.87 s | 1.10 GiB | Retain only subchunk keys and source locations. Load values for the requested tile. This reduced the observed peak from about 12 GiB and prevented OOM. |
| Drain into packed key groups and use allocation-light hex encoding | 33.41 s | 1.15 s | 1.03 s | 1.00 GiB | Delete effective-key entries while transforming them. Store fixed-size keys in contiguous byte arrays. Avoid `Array.from` and per-byte closures on hot key conversion paths. Live heap after GC fell from about 88 MiB to 14 MiB. |
| Two worker threads for two dense tiles | 33.90 s | 1.14 s for both | 1.06 s for both | 1.18 GiB | Keep the world index in the main process and send workers only one tile's packed keys. Throughput increased from 0.99 to 1.75 tiles/s, about 77%, for about 18% more peak RSS. |
| Cheap map-key filter and one coordinate decoder | 38.31 s | 1.24 s for both | 0.98 s for both | 1.34 GiB | Avoid creating decoded key objects while filtering. Decode X, Z, dimension, tag, and Y through one `DataView`. Against the adjacent biome-render run, index time fell 1.9%, first-render time fell 19%, and peak RSS fell 2.9%. |
| Viewer-owned persistent cache | 35.96 s cold metadata | 1.26 s render | 3.1 ms disk hit after restart | Not measured in HTTP probe | Fingerprint the world from cheap file metadata. Store metadata and final PNGs outside the renderer. Warm metadata took 27.8 ms and did not open the LevelDB index; an in-process PNG hit took 2.4 ms. A complete Playwright run fell from 1.1 min cold to 7.4 s warm. |

After the biome pass, a two-worker run retained about 21 MiB of main-process JavaScript heap after an explicit GC. Most peak RSS is temporary allocation space that V8 reserves after index construction plus worker heaps, not retained tile objects.

## Runtime scaling observations

- Eight viewer workers on a Ryzen 5 5500X3D (6 cores, 12 logical processors) reached 93% total CPU during a cold Stratos run. The world HDD was at 16% and the system SSD was at 9%, so this render phase was CPU-bound rather than storage-bound.
- Windows Task Manager showed 27.0 of 31.9 GB total system memory in use (85%), leaving about 4.9 GB of system headroom. This is a whole-system measurement, not Mapelix process RSS. Capture process-level RSS before selecting eight workers as a production default.

## Experiments in progress

| Experiment | Prediction | Result |
| --- | --- | --- |
| Record LevelDB data-block locations | Reading only relevant table blocks will lower uncached tile time. | Pending design. |
| Specialize the effective-key index for fixed Bedrock keys | Fewer objects and strings should reduce cold startup heap and CPU time. | Pending design. |

## Rejected or neutral experiments

Record changes here when they fail, regress a metric, or only move cost elsewhere. Do not hide negative results; they are useful production design data.

| Experiment | Observed result | Interpretation |
| --- | --- | --- |
| Add legacy Data2D biome keys and richer per-pixel shading | One two-worker run moved from 33.90 s / 1.18 GiB peak to 39.05 s / 1.37 GiB peak. The first pair moved from 1.14 s to 1.53 s; the repeated pair stayed near 1.03 s. | The 712 compact biome records cannot explain the extra allocation by volume. Re-run after specializing key classification and index storage. Keep this as a regression signal, not a conclusion. |
| Bundle `@mapelix/core` into the SvelteKit server | Worker rendering returned HTTP 500 because Vite rewrote the package-relative worker URL without emitting the worker file. | Keep the Node package external in server builds, or publish an explicit worker asset/entry in production packaging. |
| Replace effective-key `Array.from(...).join("")` hex encoding with repeated lookup-table concatenation | Index time regressed from 38.31 s to 51.73 s and peak RSS grew from 1.34 GiB to 1.55 GiB. | V8's repeated string concatenation retained costly intermediate string representations in this workload. Reverted. A binary or numeric key index is the next useful experiment. |
