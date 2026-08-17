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

Compare block colors without cast shadows and report the worst world XYZ,
block name, biome, water depth, and underwater block:

```sh
pnpm --filter @mapelix/core diagnose:color \
  mapelix-shadowless.png unmined-shadowless.png color-error.png \
  4 -32 -49 color-report.json surface.json
```

Compare cast shadows independently from material colors and local contours:

```sh
pnpm --filter @mapelix/core diagnose:shadows \
  mapelix.png mapelix-shadowless.png unmined.png unmined-shadowless.png \
  shadow-overlay.png 4 -32 -49 shadow-report.json surface.json
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
| Zoom-aware packed-key filtering | 41.46 s | 1× 1.65 s; 2× 0.63 s; 4× 0.37 s; 8× 0.30 s | 1× 1.17 s; 2× 0.61 s; 4× 0.38 s; 8× 0.27 s | 1.27 GiB | Keep every PNG at 256×256, reduce its world bounds at higher zooms, and filter packed keys before worker dispatch. More detailed tiles became faster because they decoded fewer chunks. PNG size also fell from 172.5 KB at 1× to 114.7 KB at 8×. |
| Remove generated per-block grain and bevels | 42.03 s | 1× 1.41 s; 2× 0.55 s; 4× 0.34 s; 8× 0.15 s | 1× 1.26 s; 2× 0.57 s; 4× 0.26 s; 8× 0.15 s | 1.28 GiB | Keep material color flat and block-sized. Decorative cover uses its supporting ground height and does not cast false terrain shadows. The grid ratio at `(-2950, -2630)` fell from 1.93 to 0; the 8× PNG fell from 114.7 KB to 56.8 KB. These timings include the later-rejected bilinear light field and are retained only as that experiment's performance record. |
| Output-resolution height normals and shadow rays | 49.22 s | 1× 1.62 s; 2× 0.59 s; 4× 0.35 s; 8× 0.18 s | 1× 1.45 s; 2× 0.61 s; 4× 0.37 s; 8× 0.18 s | 1.27 GiB | Nearest-expand terrain heights, then derive Lambert edge light and directional shadows at output resolution. The flat-area grid ratio stayed 0. Against the rejected blur, dense-tile mean Sobel rose 63%, mean absolute Laplacian rose 135%, and strong-edge pixels rose from 9.6% to 24.3%. |
| Selective shared-edge contour and discrete biome tint | 89.55 s | 4× 0.33 s | Not measured | 1.52 GiB | At native 4× detail on aligned Amelix tile `(-32,-49)`, storing each height edge in one output pixel raised exact edge F1 from 0.434 to 0.677 and one-pixel-tolerant F1 from 0.701 to 0.885. Reference-edge recall rose from 58.81% to 84.73%, best alignment became `(0,0)`, and PNG size fell from 20.8 KB to 13.2 KB. Discrete biome lookup removes the unsupported spatial blur while keeping an optional blend radius for artistic use. |
| uNmINeD elevation curves and explicit path color | 83.61 s | 4× 0.30 s | Not measured | 1.52 GiB | On the same aligned Amelix tile, the land elevation overlay and piecewise lightness curve reduced mean absolute RGB-channel error from 34.76 to 21.87 and luminance error from 29.30 to 20.97. Luminance correlation rose from 0.376 to 0.517. Exact edge F1 also rose from 0.677 to 0.713. Paths now use the observed HSL(36,50%,30%) soil brown and retain only elevation lightness. |
| Native subpixel 3D-opacity shadows and artificial-material colors | 86.25 s | 4× 0.33 s | Not measured | 1.51 GiB | Matching the published 120°/45° sun ray, 40% shadow strength, 4×4 opaque hit mask, ray-chord-smoothed foliage opacity, and common roof colors raised exact edge F1 from 0.713 to 0.911 and one-pixel-tolerant F1 from 0.890 to 0.976. Luminance correlation rose from 0.517 to 0.880; mean RGB-channel error fell from 21.87 to 12.27 and luminance error from 20.97 to 9.61. The maximum-height early exit keeps a flat field cheap. |
| Vertical shadow runs instead of surface extrusion | 85.10 s | 4× 0.41 s | Not measured | 1.51 GiB | Preserve air below roofs and tree canopies instead of filling each column to its top block. Exact edge F1 rose from 0.911 to 0.922, tolerant F1 from 0.976 to 0.983, and luminance correlation from 0.880 to 0.890. Peak memory stayed flat; the 24% render-time cost marks run packing and ray lookup as a future optimization target. |
| Correct Z/X biomes, classic colors, and memoized style lookup | 88.53 s | 4× 0.72 s before memoization | Not measured | 1.51 GiB | Fixing the transposed Data2D index and matching classic grass, foliage, water, dye, light, crop, and flower colors raised published-reference edge F1 from 0.922 to 0.928 and luminance correlation from 0.890 to 0.912. RGB error fell from 11.92 to 10.60. Per-tile block-style and biome caches reduced a real-fixture 4× regression from 162/98 ms cold/repeated to 89/78 ms; the pre-color baseline was 80/67 ms. |
| Lazy modern Data3D biomes at visible Y | 98.51 s | 4× 0.55 s | Not measured | Not measured | Index Data3D keys without retaining their values, then decode only the selected tile. Correctly preserving modern IDs such as `190` and `192`, instead of treating them as legacy mutation aliases, raised published-reference exact edge F1 from 0.928 to 0.943 and tolerant F1 from 0.985 to 0.991. RGB error fell from 10.60 to 8.56 and luminance error from 8.19 to 5.61. A regression test prevents `grass_path` from receiving biome tint. |
| Reconstructed comparison-only LevelDB manifest | 6.85 s official uNmINeD open and render | One lossless 4× tile | Not measured | 379 MiB | A classic manifest over all 556 valid tables lets the official CLI render lossless PNG from an isolated copy. This removes JPEG noise from palette and shadow evaluation. The source world hashes remained unchanged; reconstructed table precedence is comparison-only and not a Minecraft repair. |
| Exact models-off receiver origin and sparse shadow sampling | 93.78 s | 4× 0.83 s | Not measured | 1.81 GiB | Reproduce uNmINeD's elevated shadow receiver and its corner/edge/interior sampling gates. On the lossless Amelix forest-town pair, shadow-mask F1 rose from 0.600 to 0.995, shadow-loss correlation rose from 0.597 to 0.994, and mean shadow loss became 0.03773 versus 0.03785. Full-image edge F1 reached 0.993 with 0.999 one-pixel-tolerant F1. Keep the physically correct receiver behind `correctReferenceBugs: true`; parity remains the default. |
| Lossless per-block color oracle | Same indexed world | 4× shadowless tile | Not measured | Same scan | Against a local lossless uNmINeD PNG, 99.83% of 4,096 blocks are within perceptual error 3 and all are within 6. Mean perceptual error is 0.346. The seven large residuals are shallow water at world Z `-3104`, exactly on a chunk boundary, which is consistent with comparison-world precedence rather than a general palette error. |
| Visible slice-run color composition | 92.85 s | 4× normal + shadowless in 0.90 s | Not measured | 1.77 GiB | Preserve glass and water as visible vertical runs, apply translucent color once per run, and select biome style from every visible layer. On the technical-array oracle, mean block perceptual error fell from 6.49 to 0.18; 97.78% of blocks are within error 3 and 99.44% are within 6. Normal-image mean channel error fell from 18.01 to 1.61. The XYZ report isolated the original glass-over-seagrass mistake at world `(-1336,62,-640)`. |
| Final eight-worker renderer check | 45.64 s | 4.17 s for all eight | 3.39 s for all eight | 3.63 GiB | The full 3D-opacity renderer sustained 1.92 cold and 2.36 repeated tiles/s with 8.68–8.70 effective CPU cores. Peak renderer RSS stayed below 4 GiB with `--max-old-space-size=1536`. A fresh-cache Playwright run passed in 1.2 minutes after visual-baseline approval; the same disk cache passed in 12.3 seconds. |

After the biome pass, a two-worker run retained about 21 MiB of main-process JavaScript heap after an explicit GC. Most peak RSS is temporary allocation space that V8 reserves after index construction plus worker heaps, not retained tile objects.

The first visual comparison selected 4×4 pixels per block as the best general detail level. It makes tree crowns and structure edges readable without dominating the viewport. The untextured 8×8 level is useful for close inspection, but actual resource-pack top textures are the correct next source of within-block detail.

An early 8×8 pass restarted a brightness gradient and seeded noise inside every block. Removing only the diagonal was insufficient: the exact flat Stratos crop still had 1.93× more luminance change across block boundaries than inside them. The final untextured rule is stricter: do not generate any within-block material detail. Use actual top-face texture assets when texture mode exists.

## Current Amelix comparison workload

- Archive: `Amelix-8-12-26.zip`, 2.10 GB compressed
- World: `Amelix SMP`, about 1.2 GB with 556 table files and one log file
- Exact native tile: zoom 2, `x=-32`, `y=-49`, covering X `[-2048,-1984)` and Z `[-3136,-3072)`
- Mapelix with eight workers: 88.14 s cold in-memory index, 321.70 ms tile render, 1.53 GiB peak RSS
- Numeric oracle: local lossless uNmINeD PNG from the comparison-only classic
  manifest, `unmined-classic-z2-x-32-y-49.png`
- Published JPEG: `zoom.2/-4/-5/tile.-32.-49.jpeg`; use it only for historical
  visual checks because quality-75 chroma subsampling changes colors and edges

The geometry in this exact pair aligns. The final lossless comparison has
0.993 exact edge F1, 0.999 one-pixel-tolerant edge F1, and 0.996 luminance
correlation. Shadow-only F1 is 0.995 and shadow-loss correlation is 0.994.
Mean absolute RGB-channel error is 1.20. The first symmetric-normal baseline
had 39.27 mean Sobel energy, 18.28% strong-edge pixels, and 58.81% reference
edge recall with one-pixel tolerance. Replacing it with one stored contour per
shared height edge raised those values to 47.74, 28.83%, and 84.73%. The exact
edge F1 rose from 0.434 to 0.677; one-pixel-tolerant F1 rose from 0.701 to
0.885. This confirms that missing local structure was more important than
misplaced structure. The remaining reference-only edges cluster around cast
shadows and small material features.

The seven-scene lossless suite also checks snow, coast, dense canopy, flat
grass, a dry biome boundary, and a technical block array. The technical-array
milestone is in `/home/caches/Repos/.mapelix-comparisons/amelix/suite-v15`.
Its shadowless block-color comparison has mean perceptual error `0.180`; 99%
of blocks are exact at the median and 99.44% are within error 6. Its normal
image has mean channel error `1.61`, luminance correlation `0.947`, and best
alignment `(0,0)`. Shadow-mask F1 is `0.884`; the remaining mismatch is mostly
missing shadow coverage, not misplaced material color or terrain noise.

The official uNmINeD 0.20.1 Linux CLI is usable as a local oracle. The original
backup manifest references missing table `32439120`, so the CLI rejects it.
An isolated comparison copy with a reconstructed classic manifest opens all
556 valid tables and produces lossless PNGs. Do not treat that manifest as a
Minecraft world repair; it exists only to keep renderer comparisons aligned.

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
