# Classic 2D overview zooms

`@mapelix/core/node/batch` and `@mapelix/render-cli` export overview zooms -4..-1 and native zooms
0..+2 by default. Explicit native +3 remains compatible with earlier callers. Textures and camera
projection are independent of this image pipeline.

## Grid and pixels

Every PNG is 256 by 256 pixels. X increases east; tile Y increases south, along Minecraft Z.
The grid follows `pixelsPerBlock = 2^zoom` and `blockSpan = 256 / 2^zoom`:

| Zoom | Pixels per block | Blocks per tile axis | Maximum zoom-0 sources per overview |
| ---- | ---------------: | -------------------: | ----------------------------------: |
| -4   |             1/16 |                 4096 |                                 256 |
| -3   |              1/8 |                 2048 |                                  64 |
| -2   |              1/4 |                 1024 |                                  16 |
| -1   |              1/2 |                  512 |                                   4 |
| 0    |                1 |                  256 |                    Native rendering |
| +1   |                2 |                  128 |                    Native rendering |
| +2   |                4 |                   64 |                    Native rendering |

The portable core entry exports `mapPixelsPerBlock`, `mapTileBounds`, `mapTileAncestor` and
`DEFAULT_MAP_ZOOMS`. Bounds have exclusive maxima. Ancestors use floor division: source tile
`(x=-1,y=-17,z=0)` belongs to `(x=-1,y=-2,z=-4)`. Truncation toward zero would put it in the wrong
image. Neighbors meet exactly at their shared world-coordinate boundary.

An overview pixel represents an integer-aligned square of 2, 4, 8 or 16 native pixels per axis.
Those squares never straddle a zoom-0 tile boundary because each scale divides 256. No filter halo
or border replication is needed. Sparse source cells map only to their own ancestors; unexplored
gaps do not create a filled rectangle between distant islands.

## Filtering and transparency

Every overview reads zoom-0 PNGs directly. It does not use a rounded -1 PNG as input to -2, and it
does not rerender the Minecraft world for each overview level. Render options, biome tint, included
height, water and shadows are already present in the native image.

For an output footprint containing `N = scale * scale` pixels, with eight-bit straight RGBA:

```text
alpha = round(sum(A) / N)
R     = round(sum(R * A) / sum(A))
G     = round(sum(G * A) / sum(A))
B     = round(sum(B * A) / sum(A))
```

If the rounded alpha is zero, RGBA is canonical transparent black. Missing sources contribute zero
alpha and retain their full footprint in the denominator. RGB hidden beneath zero alpha cannot
darken the visible shore, edge of a cave opening or unexplored boundary. Partial coverage remains
partial alpha, suitable for any host background. Colors are averaged in the existing sRGB byte
space, with no added linear-light or gamma correction.

The accumulator keeps exact integer sums and rounds once at the target zoom. At -4, a single opaque
native pixel becomes alpha 1 while retaining its color. Native RGBA and PNG bytes are unchanged.

## Bounded source reuse

A -4 tile geometrically covers 16 by 16 zoom-0 tiles. This does not mean 256 new world renders per
overview. The batch plans the union of stored zoom-0 dependencies and renders each source once.
Published zoom-0 PNGs are reused. If zoom zero is not requested, or a whole overview needs sources
outside the selected native bounds, those PNGs live only in an owned stage directory and are removed
before final inventory verification and publication.

Composition streams one decoded source at a time per accepted overview task. Its integer-sum buffer
is 1 MiB; it does not allocate a 4096 by 4096 mosaic or retain 256 decoded images. Output RGBA,
compressed PNGs and codec buffers add temporary memory. The existing pending-job limit bounds both
native work and overview composition. Native workers are closed before the composition phase;
composition runs in the supervised coordinator and remains covered by cancellation and deadlines.

Selecting all four overview levels reads each stored zoom-0 PNG four times, once per level. This
trades additional PNG reads/decodes for a single rounding step and removes the need to store
intermediate unrounded pyramids. It is not incremental reuse across exports. PNG I/O and filtering
costs depend on storage, world coverage and compression; measure them for deployment workloads.

`--bounds` selects intersecting whole output tiles, rather than clipping their pixels. If a selected
overview covers a zoom-0 source outside the requested bounds, that source is still included.
Otherwise narrowing a selection would change the PNG at the same XYZ coordinate and create seams.

All required work is included in preflight `maxTiles`: published native/overview tiles plus temporary
zoom-0 sources. `maxOutputBytes` counts all new PNGs, including temporary sources, and both manifests.
It bounds generated bytes conservatively even after temporary sources have been deleted. The
manifest's `tileCount` and `pngBytes` describe only the published inventory.

## API and manifest compatibility

`MapWorld.renderTile` remains the native renderer for 0..+3. The separate streaming compositor is
available through the core Node entry:

```ts
import { createOverviewTile, decodePng } from "@mapelix/core/node";

const coordinates = { dimension: "overworld" as const, z: -1, x: -1, y: -1 };
const sources = [
  { coordinates: { ...coordinates, z: 0 }, rgba: decodePng(cachedZoomZeroPng, 256, 256) },
];
const overview = await createOverviewTile(coordinates, sources, signal);
```

`sources` may also be an async iterable. Omitted sources are transparent. Duplicate, out-of-bounds,
wrong-dimension and non-zoom-zero sources are refused. The helper accepts an `AbortSignal`; the
batch adapter owns snapshot planning, queue limits and publication. The Node `encodePng`/`decodePng`
helpers reuse the reference codec; decoding validates expected image dimensions before inflation.
No external runtime dependency is added.

Manifest schema version 1 retains the same XYZ formula and relative path convention. Exports
selecting negative zooms add the following optional fields:

```json
{
  "grid": {
    "overview": { "sourceZoom": 0, "filter": "area-premultiplied-srgb-v1" }
  },
  "work": { "tileJobs": 18, "temporaryTiles": 6, "temporaryPngBytes": 2400 }
}
```

This is a selected-field example. `grid.zooms` lists only requested output levels. The optional work
fields disclose dependencies omitted from the final inventory. Native-only exports omit both
additions. Hosts can detect overview support through `grid.overview` and use the available zoom list,
rather than assuming a fixed range. A tiled web consumer should use the exported minimum as
`minNativeZoom`, disable wrapping and retain the Minecraft XYZ axis convention.

An older native-only manifest is still accepted as the previous publication. Lock ownership,
symlink/junction restrictions, byte verification, failure cleanup and final atomic pointer replacement
are unchanged. See the [CLI contract](../apps/render-cli/README.md) for filesystem, memory-budget and
power-loss limitations.

## Performance

Overview composition is cheap: about 0.3 s for all four overview levels of the local Overworld
snapshot. Export time is dominated by native zooms 0..+2 and their shadow halo. Measurements, the
profile and the shared caches that cut the full Overworld export from 151 s to about 14.5 s are in
[2D export performance](2d-performance.md).

## Validation

Tests compare overview pixels to an independent world-coordinate area oracle at -4 and -1,
including negative parents, tile seams, missing quadrants, hidden RGB, partial alpha, thin features
and maximum input coverage. Integration cases verify all default levels in three dimensions,
unchanged native PNGs, deterministic worker counts, overview-only source reuse, narrow bounds,
hidden-work and byte limits, and cancellation after composition begins. Real snapshots remain
read-only; generated previews and measurements stay under ignored local storage.
