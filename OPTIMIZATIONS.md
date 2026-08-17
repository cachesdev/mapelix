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
| Retain compact biome payloads for the render halo | 42.97 s | 1.26 s for both | 1.14 s for both | 1.60 GiB | Keep only the 256/512-byte biome payload, not the unused 512-byte Data2D height prefix. Send the halo with worker jobs instead of reopening LevelDB files. This restored repeated rendering from 3.08 s to 1.14 s and cut retained array buffers from about 230 MiB to 110 MiB. |
| Eight workers for eight dense visual tiles | 42.68 s | 2.07 s for all eight | 1.96 s for all eight | 2.53 GiB | The process reached 4.08 tiles/s and used 9.19 CPU cores during the first batch. Compared with two workers, throughput improved 2.33× for 4× the workers, about 58% parallel efficiency. Actual Mapelix peak RSS stayed below 4 GiB. |

After the biome pass, a two-worker run retained about 21 MiB of main-process JavaScript heap after an explicit GC. Most peak RSS is temporary allocation space that V8 reserves after index construction plus worker heaps, not retained tile objects.

## Runtime scaling observations

- Eight viewer workers on a Ryzen 5 5500X3D (6 cores, 12 logical processors) reached 100% total CPU while enough cold tiles remained queued. The captured 93% reading was after the renderer began to run out of tiles. The world HDD was at 16% and the system SSD was at 9%, so this render phase was CPU-bound rather than storage-bound.
- Windows Task Manager showed 27.0 of 31.9 GB total system memory in use (85%), leaving about 4.9 GB of system headroom. This was a whole-system measurement. The later eight-worker Node benchmark measured Mapelix itself at 2.53 GiB peak RSS.

## Experiments in progress

| Experiment | Prediction | Result |
| --- | --- | --- |
| Record LevelDB data-block locations | Reading only relevant table blocks will lower uncached tile time. | Pending design. |
| Specialize the effective-key index for fixed Bedrock keys | Fewer objects and strings should reduce cold startup heap and CPU time. | Pending design. |
| Pack retained biome records by tile | Replacing per-record objects with compact numeric coordinates and contiguous payloads should reduce the retained main-process heap and worker structured-clone cost. | Pending design. |

## Rejected or neutral experiments

Record changes here when they fail, regress a metric, or only move cost elsewhere. Do not hide negative results; they are useful production design data.

| Experiment | Observed result | Interpretation |
| --- | --- | --- |
| Add legacy Data2D biome keys and richer per-pixel shading | One two-worker run moved from 33.90 s / 1.18 GiB peak to 39.05 s / 1.37 GiB peak. The first pair moved from 1.14 s to 1.53 s; the repeated pair stayed near 1.03 s. | The 712 compact biome records cannot explain the extra allocation by volume. Re-run after specializing key classification and index storage. Keep this as a regression signal, not a conclusion. |
| Bundle `@mapelix/core` into the SvelteKit server | Worker rendering returned HTTP 500 because Vite rewrote the package-relative worker URL without emitting the worker file. | Keep the Node package external in server builds, or publish an explicit worker asset/entry in production packaging. |
| Replace effective-key `Array.from(...).join("")` hex encoding with repeated lookup-table concatenation | Index time regressed from 38.31 s to 51.73 s and peak RSS grew from 1.34 GiB to 1.55 GiB. | V8's repeated string concatenation retained costly intermediate string representations in this workload. Reverted. A binary or numeric key index is the next useful experiment. |
| Blend each biome-tinted pixel with a direct 5×5 neighbor loop | Repeated two-tile rendering regressed from 0.98 s to 3.23 s and peak RSS grew from 1.34 GiB to 1.60 GiB. | Correct visual behavior, wrong computation shape. Replace repeated style and string-key lookups with one compact tile field and an integral image. |
| Narrow biome blending and height-independent contour shadows | Two identical two-worker runs measured 1.40 s and 1.18 s for the repeated pair, or 1.43–1.70 tiles/s, with 1.65–1.66 GiB peak RSS. Cold Playwright took 59.7 s versus 58.8 s for terrain-v2. | Performance is neutral within observed run variance. A two-block biome transition, three-block shadow reach, and fixed contour tones materially improved block readability without a measurable end-to-end cost. |
