# Amelix uNmINeD export reference

**Checked:** 2026-08-16 UTC-4.  This note describes the published static export at
<https://forestoflight.github.io/AmelixSMPViewer/>.  It is evidence for visual
comparison with Mapelix; it is not a source of world data.

## Result: exact reference for the current test position

For Minecraft **X = -2950, Z = -2630** in `SMP Overworld`, use the following
native-detail reference tile:

<https://forestoflight.github.io/AmelixSMPViewer/map/tiles/smp-overworld/zoom.2/-5/-5/tile.-47.-42.jpeg>

It is a 256 x 256 JPEG and returned HTTP 200 when checked.  At `zoom.2` it
covers X `[-3008, -2944)` and Z `[-2688, -2624)`.  The requested block is at
pixel `(232, 232)` from that tile's upper-left corner, with X increasing right
and Z increasing down.

The tile is a reproducible single-image reference.  Fetch it without walking
the tile tree:

```sh
curl --fail --location \
  --output /tmp/amelix-x--2950-z--2630-unmined-z2.jpeg \
  'https://forestoflight.github.io/AmelixSMPViewer/map/tiles/smp-overworld/zoom.2/-5/-5/tile.-47.-42.jpeg'
```

The interactive equivalent is:

<https://forestoflight.github.io/AmelixSMPViewer/#rx=-2950&rz=-2630>

The fragment puts a red dot at, and centers the map on, those Minecraft
coordinates.  It does **not** store zoom.  The export opens at world zoom 0;
set OpenLayers view zoom 8 to display the native `zoom.2` tiles:

```js
// Run after the above page has loaded.
unmined.olMap.getView().setZoom(8);
```

For a deterministic viewport screenshot, use a fixed browser viewport, load
the fragment URL, run that one statement, wait for the tile URL above, then
capture.  The direct tile is preferable when comparing renderer pixels because
it avoids labels, red-dot graphics, browser scale, and viewport-dependent
neighbour tiles.

This particular former test position is almost uniform water in the native
tile, so it is a poor place to tune terrain-edge lighting.  A much better
terrain/structure comparison point from the same map is **Forest's Town** at
`(-2016, -3120)`: [interactive marker link](https://forestoflight.github.io/AmelixSMPViewer/#rx=-2016&rz=-3120)
and [its native tile](https://forestoflight.github.io/AmelixSMPViewer/map/tiles/smp-overworld/zoom.2/-4/-5/tile.-32.-49.jpeg).
That coordinate is at tile pixel `(128, 64)`.  The latter tile is 14,353 bytes
(rather than the water tile's 1,637 bytes) and has terrain and construction
detail suitable for checking crisp highlights and shade boundaries.

## Published map bounds and coordinate transform

The live map-properties file declares `SMP Overworld` as `smp-overworld`, with
region X `-85..19531`, region Z `-58..19531`, centre `(0, 0)`, and native
uNmINeD zoom range `-6..2`.  A region is 512 blocks in the export client, so
the declared rectangular block extent is:

| Axis | Inclusive block range |
| --- | --- |
| X | `-43520..10000383` |
| Z | `-29696..10000383` |

This is an **advertised extent**, not a promise that every block is rendered:
the separate [region bitset index](https://forestoflight.github.io/AmelixSMPViewer/map/unmined.map.regions.js)
lets the viewer omit tiles with no known region.

The viewer's data coordinates are ordinary Minecraft `(X, Z)`.  Its temporary
OpenLayers view projection is only a display conversion:

```
blocksPerDegree = max(30,000,000, largest advertised coordinate) / 270
viewX = X / blocksPerDegree
viewY = -Z / blocksPerDegree
```

For this export, `blocksPerDegree = 111111.111111…`; therefore `(-2950,
-2630)` becomes `(-0.02655, 0.02367)`.  This matches a live browser probe.
The negative sign is why image rows still grow with Minecraft Z, despite
OpenLayers' upward-positive display axis.  The implementation is in the
published [viewer source](https://forestoflight.github.io/AmelixSMPViewer/unmined.js).

## Tile and zoom mapping

The export uses 256-pixel tiles.  Let `W` be the number in `zoom.W` and let
`X`, `Z` be Minecraft block coordinates.  The published client computes:

```
blocksPerTile = 256 / 2^W
tileX = floor(X / blocksPerTile)
tileZ = floor(Z / blocksPerTile)
directoryX = floor(tileX / 10)
directoryZ = floor(tileZ / 10)
URL = map/tiles/smp-overworld/zoom.W/directoryX/directoryZ/tile.tileX.tileZ.jpeg
```

The native values are `W = -6, -5, -4, -3, -2, -1, 0, 1, 2`.  The associated
block coverage per 256-pixel tile is `16384, 8192, 4096, 2048, 1024, 512, 256,
128, 64`; `W=2` is thus four source pixels per block.  The public map uses an
OpenLayers zoom `V` from 0 through 8, related by `W = V - 6`.  Its default
`V=6` means `W=0`, while native detail is `V=8`.

For the reference position above:

```
W = 2
blocksPerTile = 64
tileX = floor(-2950 / 64) = -47
tileZ = floor(-2630 / 64) = -42
directoryX = floor(-47 / 10) = -5
directoryZ = floor(-42 / 10) = -5
```

Use mathematical `floor`, particularly for negative tile numbers.  Truncating
`-47 / 10` toward zero would incorrectly request directory `-4`.

## Local CLI oracle

The official Linux x64 CLI is available and suitable as a black-box renderer.
Version `0.20.1-dev+2c464b0e75bbe9cc105fe2046151005c48ec75fc` ran natively on
Fedora 43 under WSL with its bundled .NET 10 runtime.  The relevant image
options are:

- `--area=b(x,z,width,height)` for exact block bounds;
- `--zoom=2` for four output pixels per block;
- `--shadows=false|true|2d|3d|3do`;
- `--blockrender` for block-model rendering at 1:4 and higher;
- `--chunkprocessors=N` for concurrency;
- `--mapsettings=FILE` for a saved visual configuration.

This makes the intended local comparison deterministic.  The Forest's Town
reference tile is one image command over `b(-2048,-3136,64,64)` at zoom 2.
The current `Amelix-8-12-26.zip` backup cannot yet complete that command in
uNmINeD: its `MANIFEST-32430469` refers to removed table `32439120`, which is
not present in the archive.  uNmINeD exits during its strict manifest scan.
Removing `CURRENT` and the manifest in a disposable hard-linked copy does not
make uNmINeD fall back to a raw table scan.  Mapelix's direct record scan does
open the same backup and rendered the exact requested bounds.

Keep the official binary and all oracle outputs outside Git.  Its license
permits free use but forbids modification and redistribution.  The official
download and license pages are listed in Sources.

## Exact aligned comparison

Mapelix rendered native tile `z=2, x=-32, y=-49` from the copied `Amelix SMP`
world.  Its bounds were exactly X `[-2048,-1984)` and Z `[-3136,-3072)`, the
same as the published uNmINeD tile.  Buildings, paths, trees, and terrain
contours align in the two images.  This proves the tile-coordinate transform
without relying on a browser screenshot.

The first palette-independent edge comparison used a Sobel threshold of 80:

| Signal | Mapelix | Published uNmINeD |
| --- | ---: | ---: |
| Mean Sobel energy | 39.27 | 86.15 |
| Strong-edge pixels | 18.28% | 38.14% |
| Block-boundary/interior delta ratio | 1.96 | 3.16 |
| Mean within-block luminance deviation | 5.38 | 10.55 |

With a one-pixel tolerance and the best measured offset `(0, 1)`, 86.62% of
Mapelix's strong edges have a uNmINeD edge, but Mapelix recalls only 58.81% of
uNmINeD's edges.  This is a useful target: Mapelix generally puts its existing
edges in the right place, but uNmINeD carries about twice as much high-frequency
structure.  The aligned edge overlay shows most missing reference detail on
vertical faces, cast-shadow boundaries, and small material features.  It does
not support applying a global sharpen or block grid.

Generate the metrics and overlay with:

```sh
pnpm --filter @mapelix/prototype diagnose:compare \
  path/to/mapelix.png \
  path/to/unmined.jpeg \
  /tmp/mapelix-unmined-edges.png \
  4
```

The overlay uses cyan for Mapelix-only edges, red for uNmINeD-only edges, and
white for exact overlap.  The script searches offsets up to four pixels and
reports exact and one-pixel-tolerant precision/recall.  Use this structural
signal alongside visual inspection; JPEG noise and different material colors
make raw pixel error unsuitable.

## Exposed visual metadata and implication

The published [properties](https://forestoflight.github.io/AmelixSMPViewer/map/unmined.map.properties.js)
expose only raster/viewer settings for the overworld: `imageFormat: "jpeg"`,
background `#78a7ff`, grid capability enabled but initially hidden, centre
`(0,0)`, and marker data.  The [page](https://forestoflight.github.io/AmelixSMPViewer/)
loads this metadata and `unmined.js`; the latter builds an OpenLayers `XYZ`
layer whose URL points at pre-generated JPEGs.  The [export stylesheet](https://forestoflight.github.io/AmelixSMPViewer/index.css)
sets `image-rendering: pixelated` on the map, so browser presentation does not
smooth those raster pixels.

There is no exposed shader, lighting, texture, ambient-occlusion, or block-edge
parameter in the export.  Therefore the bright and shaded block boundaries are
baked into the source JPEGs before this web viewer receives them.  The right
comparison method is pixel-level comparison against `zoom.2` tiles, not trying
to reproduce a browser-side CSS or WebGL setting that is absent from the
export.

Visual inspection of the [Forest's Town native tile](https://forestoflight.github.io/AmelixSMPViewer/map/tiles/smp-overworld/zoom.2/-4/-5/tile.-32.-49.jpeg)
refines the working hypothesis: the map does retain material/detail variation,
but does not place a global block grid over flat grass or roofs.  Its crisp
one-to-two-raster-pixel contours and cast shade occur at real terrain or build
height changes.  The useful target is therefore selective, baked-looking edge
light, with flat interiors left quiet—not a global blur or global texture
filter.  Set device-pixel-ratio to 1 for a screenshot comparison at `W=2` so
that its four raster pixels per Minecraft block are also four CSS pixels.

## Sources

All behavioural claims above are based on the first-party artefacts served by
this export:

- [Viewer HTML](https://forestoflight.github.io/AmelixSMPViewer/)
- [Map properties](https://forestoflight.github.io/AmelixSMPViewer/map/unmined.map.properties.js)
- [Region availability index](https://forestoflight.github.io/AmelixSMPViewer/map/unmined.map.regions.js)
- [Published uNmINeD viewer client](https://forestoflight.github.io/AmelixSMPViewer/unmined.js)
- [Published viewer stylesheet](https://forestoflight.github.io/AmelixSMPViewer/index.css)
- [Verified `(-2950, -2630)` native tile](https://forestoflight.github.io/AmelixSMPViewer/map/tiles/smp-overworld/zoom.2/-5/-5/tile.-47.-42.jpeg)
- [Official uNmINeD downloads](https://unmined.net/downloads/)
- [Official CLI getting started guide](https://unmined.net/docs/cli/getting-started/)
- [Official uNmINeD license](https://unmined.net/license/)
