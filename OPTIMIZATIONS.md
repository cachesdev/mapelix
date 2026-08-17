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

Compare the same hotspot across native zooms with:

```sh
MAPELIX_BENCH_WORLD=/tmp/mapelix-stratos-tmbcraft-pruned-v2 \
MAPELIX_BENCH_WORKERS=1 \
pnpm --filter @mapelix/core benchmark:zoom
```

Measure periodic block-grid contrast in a rendered tile with:

```sh
pnpm --filter @mapelix/core diagnose:grid \
  http://127.0.0.1:5173/tiles/3/-93/-83.png 8 200 200 16
```

Measure Sobel and Laplacian edge energy with:

```sh
pnpm --filter @mapelix/core diagnose:sharpness path/to/tile.png
```

Compare an aligned Mapelix PNG with a PNG or JPEG reference renderer:

```sh
pnpm --filter @mapelix/core diagnose:compare \
  path/to/mapelix.png path/to/reference.jpeg /tmp/edge-overlay.png 4
```

The edge overlay uses cyan for Mapelix-only edges, red for reference-only
edges, and white for exact overlap. The command also reports alignment,
one-pixel-tolerant edge precision and recall, block-grid contrast, and
within-block luminance variation.

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
| Zoom-aware packed-key filtering | 41.46 s | 1× 1.65 s; 2× 0.63 s; 4× 0.37 s; 8× 0.30 s | 1× 1.17 s; 2× 0.61 s; 4× 0.38 s; 8× 0.27 s | 1.27 GiB | Keep every PNG at 256×256, reduce its world bounds at higher zooms, and filter packed keys before worker dispatch. More detailed tiles became faster because they decoded fewer chunks. PNG size also fell from 172.5 KB at 1× to 114.7 KB at 8×. |
| Remove generated per-block grain and bevels | 42.03 s | 1× 1.41 s; 2× 0.55 s; 4× 0.34 s; 8× 0.15 s | 1× 1.26 s; 2× 0.57 s; 4× 0.26 s; 8× 0.15 s | 1.28 GiB | Keep material color flat and block-sized. Decorative cover uses its supporting ground height and does not cast false terrain shadows. The grid ratio at `(-2950, -2630)` fell from 1.93 to 0; the 8× PNG fell from 114.7 KB to 56.8 KB. These timings include the later-rejected bilinear light field and are retained only as that experiment's performance record. |
| Output-resolution height normals and shadow rays | 49.22 s | 1× 1.62 s; 2× 0.59 s; 4× 0.35 s; 8× 0.18 s | 1× 1.45 s; 2× 0.61 s; 4× 0.37 s; 8× 0.18 s | 1.27 GiB | Nearest-expand terrain heights, then derive Lambert edge light and directional shadows at output resolution. The flat-area grid ratio stayed 0. Against the rejected blur, dense-tile mean Sobel rose 63%, mean absolute Laplacian rose 135%, and strong-edge pixels rose from 9.6% to 24.3%. |

After the biome pass, a two-worker run retained about 21 MiB of main-process JavaScript heap after an explicit GC. Most peak RSS is temporary allocation space that V8 reserves after index construction plus worker heaps, not retained tile objects.

The first visual comparison selected 4×4 pixels per block as the best general detail level. It makes tree crowns and structure edges readable without dominating the viewport. The untextured 8×8 level is useful for close inspection, but actual resource-pack top textures are the correct next source of within-block detail.

An early 8×8 pass restarted a brightness gradient and seeded noise inside every block. Removing only the diagonal was insufficient: the exact flat Stratos crop still had 1.93× more luminance change across block boundaries than inside them. The final untextured rule is stricter: do not generate any within-block material detail. Use actual top-face texture assets when texture mode exists.

## Current Amelix comparison workload

- Archive: `Amelix-8-12-26.zip`, 2.10 GB compressed
- World: `Amelix SMP`, about 1.2 GB with 556 table files and one log file
- Exact native tile: zoom 2, `x=-32`, `y=-49`, covering X `[-2048,-1984)` and Z `[-3136,-3072)`
- Mapelix with eight workers: 88.14 s cold in-memory index, 321.70 ms tile render, 1.53 GiB peak RSS
- Published oracle: uNmINeD `zoom.2/-4/-5/tile.-32.-49.jpeg`

The geometry in this exact pair aligns. At a Sobel threshold of 80, Mapelix
has 39.27 mean edge energy and 18.28% strong-edge pixels; uNmINeD has 86.15
and 38.14%. With one-pixel tolerance, 86.62% of Mapelix edges match uNmINeD,
while Mapelix recalls 58.81% of uNmINeD edges. This indicates missing local
structure more than misplaced structure. A global sharpen is not the target:
the missing reference edges cluster around height faces, cast shadows, and
small material features.

The official uNmINeD 0.20.1 Linux CLI is usable as a local oracle, but it
rejects this backup before rendering because its manifest references missing
table `32439120`. Mapelix's raw record scan tolerates the backup and rendered
the aligned tile. Use a clean Bedrock checkpoint when comparing fresh outputs
from both renderers.

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
| Procedural per-block texture and edge relief | At `(-2950, -2630)`, the 8× tile had a 1.93 periodic-grid ratio even after removing its repeated diagonal gradient. | A separate micro-image per block is the wrong primitive for an untextured cartographic map. It was removed rather than blurred. |
| Bilinearly interpolate block-center lighting | The flat-area grid disappeared, but every tree crown, shoreline, structure edge, and shadow became visibly soft. | Interpolation was a low-pass filter over the signal we needed to preserve. Derive a one- or two-pixel response from output-resolution height discontinuities instead. |
