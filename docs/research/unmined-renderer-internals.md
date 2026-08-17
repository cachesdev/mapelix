# uNmINeD renderer internals: clean-room behavior notes

**Inspected:** 2026-08-16 UTC-4

**Reference build:** uNmINeD CLI `0.20.1-dev+2c464b0e75bbe9cc105fe2046151005c48ec75fc`, Linux x64

**Binary SHA-256:** `eb19961e575303fe4880f531e2a6ef2759aeabe23582c7c229d24365a9656fa6`

This note records renderer behavior that is useful for Mapelix. It does not
contain copied uNmINeD source. The proprietary binary, extracted assemblies,
decompiler output, and rendered oracle files stay outside Git. The bundled
default configuration pack has its own MIT license; the application license
still forbids modification and redistribution.

## Result

The main visual trick is smaller and more specific than a texture system or a
global lighting filter:

1. At a positive native zoom, uNmINeD allocates `2^zoom` image pixels for each
   Minecraft block. The published Amelix maximum is zoom 2, or **4 x 4 image
   pixels per block**.
2. Without block-model rendering, it fills that whole square with one resolved
   material color.
3. At zoom 1 and 2, it adds a selective one-pixel bright or dark contour only
   where adjacent ground heights differ. It stores each boundary once, on the
   north or west edge of a block. Equal-height neighbors cause no visible
   change, so flat ground has no global grid.
4. Cast shadows are a separate pass. The published export explicitly uses the
   `3do` mode. The caster samples rays at image subpixels, not once per
   Minecraft block. At zoom 2, a shadow boundary can therefore have up to
   4 x 4 positions inside a solid-color block. This is the strongest
   explanation for the extra detail in shaded uNmINeD areas.
5. The public export does not enable block models. Its block interiors are
   style-color fills; paths stand out because of an explicit path style, not a
   15/16-height model.
6. The broad heatmap look is mostly an absolute-elevation color and lightness
   style. It is not biome blur. The inspected Bedrock path does not spatially
   blend biome colors.

These passes preserve sharp material boundaries. There is no global blur and
no unconditional per-block outline.

## Inspection method and confidence

The official single-file Linux executable was unpacked outside the repository.
ILSpy 11 decompiled its managed assemblies successfully. The behavior below
was traced through named types and methods, and checked against the CLI help,
the distributed default configuration, and the published Amelix zoom-2 tile.
The Amelix update script records its CLI flags but does not pin an uNmINeD
version, so it cannot prove that the published tile used this exact build.

Labels used below:

- **Fact** means the control flow or value is directly present in the inspected
  build or its distributed configuration.
- **Inference** means the source establishes the available behavior, but the
  static web export does not expose the setting needed to prove which option
  Forest used.

## Render pipeline

The relevant data flow is:

```text
world chunk columns
  -> TerrainDbBlocksToSliceBlocksConverter
  -> visible SliceBlock stack and surface metadata
  -> TerrainRendererState.RenderBlock or RenderBlockTextured
  -> TerrainShaderState / ElevationMap
  -> TerrainRendererState.ApplyShade
       -> local elevation contour
       -> optional subpixel ray-cast shadow
       -> optional cave-opening contour
  -> 256 x 256 native tile
  -> negative zoom tiles resampled from the next higher level
```

The central types are:

- `Unmined.Core.Tiles.Terrain.Slice.TerrainDbBlocksToSliceBlocksConverter`
- `Unmined.Core.Render.Terrain.ElevationMapGenerator`
- `Unmined.Core.Render.Terrain.TerrainRendererState<TPixel>`
- `Unmined.Core.Render.Terrain.TerrainShader`
- `Unmined.Core.Render.Terrain.ShadowCaster`
- `Unmined.Core.Render.Terrain.ShadowRayCast`
- `Unmined.Core.Processing.TerrainRendererChunkProcessorRequest<TPixel>`
- `Unmined.Core.Processing.TerrainRendererService<TPixel>`

## Native zoom and pixels per block

**Fact.** `TerrainRendererState<TPixel>` derives `ZoomFactor` by raising two to
`ZoomLevel`. `SetColor` fills a `ZoomFactor x ZoomFactor` rectangle for every
block. `TerrainRenderRequest<TPixel>` allocates the destination at this native
size.

The web exporter renders each non-negative zoom from the world:

| uNmINeD zoom | Pixels per block | Blocks in a 256 px tile |
| ---: | ---: | ---: |
| 0 | 1 | 256 |
| 1 | 2 | 128 |
| 2 | 4 | 64 |
| 3 | 8 | 32 |

The published Amelix export stops at zoom 2. Its sharpest tile is therefore a
native 4-pixel-per-block render, not a browser upscale of a one-pixel render.

**Fact.** Negative web zooms are different. `WebMapExport.RenderZoomOutTiles`
combines four tiles from the next level and resizes them with ImageSharp's
Lanczos8 resampler. They are not rerendered from block data.

## Surface selection

**Fact.** `TerrainDbBlocksToSliceBlocksConverter.GetSliceBlock` walks each
column from top to bottom and produces visible runs. Air is skipped. Solid,
fluid, non-blocking, waterlogged, filtered, and underground states are tracked
separately. The top visible run carries:

- block state and biome;
- top Y and run length;
- fluid depth;
- cave height and underground status;
- block light.

`TerrainRendererState.RenderBlock` resolves the top block color. When that
color is translucent, it walks lower visible runs and alpha-composites them
until the result is opaque. This is how shallow water and glass reveal lower
materials without keeping an arbitrary full column image.

**Fact.** `ElevationMapGenerator.GenerateElevationMap` skips blocks tagged
`#shadeless` when choosing the height used for local relief. The default tag
pack includes grass, flowers, saplings, stems, sprouts, candles, torches,
rails, and carpets. These objects can remain visible without making the ground
height jump. Leaves are not shadeless, so tree canopies still receive relief.

This separation is important: the rendered top material and the relief surface
do not always have to be the same block.

## Base color and the elevation heatmap

**Fact.** `TerrainRendererState.GetBlockColor` resolves a block in this order:

1. base style color;
2. grass, foliage, or water biome tint when enabled;
3. an elevation color gradient, alpha-composited over the base;
4. an elevation lightness curve;
5. a depth curve or night-light adjustment;
6. final saturation and lightness effects.

The default MIT-licensed stylesheet enables `useLandElevationGradient`. It
defines these ordinary-overworld anchors for a Bedrock world compatible with
Minecraft 1.18 or newer:

| Symbol | Y |
| --- | ---: |
| minimum | -64 |
| sea | 62 |
| sea minus 32 | 30 |
| mountain | 112 |
| maximum | 319 |

The ordinary `land` elevation overlay is HSL `(36, 90%, 30%)`, approximately
RGB `(145, 90, 8)`. Its alpha is zero at Y=62, grows linearly to 255 at Y=112,
and stays clamped at the nearest endpoint outside that interval. The ordinary
ground base is HSL `(78, 95%, 40%)`, approximately RGB `(141, 199, 5)`, before
biome-specific rules and tinting.

The independent `land.lightness.elevation` curve is:

| Y | RGB multiplier |
| ---: | ---: |
| -64 | 0.875 |
| 30 | 0.925 |
| 62 | 1.000 |
| 112 | 0.925 |
| 319 | 0.875 |

Both tables use piecewise-linear interpolation at integer Y. Color resolution
first alpha-composites the elevation overlay over the base color in byte RGB
space, then multiplies RGB by the lightness curve. This is not HSL lightness
interpolation despite the configuration's HSL color declarations.

Sand, red sand, and rock use the same sea-to-mountain alpha schedule with
mountain overlay HSL values `(48, 40%, 50%)`, `(24, 70%, 45%)`, and
`(0, 0%, 60%)`. Savanna, taiga, dark-forest, and swamp ground use their own
base colors but the same ordinary brown mountain overlay.

This creates smooth color bands over geographic distance because nearby terrain
usually changes height gradually. It can look like a spatial heatmap even
though the renderer looks up each block's own Y independently.

Sources: the bundled MIT `default.stylesheet.minecraft.js`,
`BedrockWorldDimension`, `StylesheetCompilationContext.GenerateGradient`,
`StylesheetCompilationContext.GenerateCurveMapping`, and
`TerrainRendererState.GetBlockColor`.

## The selective block contour

### Zoom 1 and 2: the path used by the published Amelix tile

**Fact.** `TerrainRendererState.ApplyShade` calls
`TerrainShader.ApplyShadingOnPixel` for positive zooms below 3.

For each block, that method compares the water-adjusted ground height with the
north and west neighbors. It writes only one row or column inside the block.
The sun-direction quadrant decides whether a given signed height difference is
treated as light-facing or shade-facing.

The exact stored edges are:

- north comparison: the current block's top image row, from its top-left pixel
  toward the right;
- west comparison: the current block's left image column, from its top-left
  pixel downward.

The top-left output pixel therefore receives both adjustments when both edges
have a height change.

The clean-room response for an oriented integer height difference `d` is:

```text
if d < 0:
    raw = 1.5 * d / 128 * 28.8
else:
    raw = 1.5 * floor((d + 1) / 2) / 128 * 28.8

v = clamp(raw, -0.3, +0.3) * material_shading_factor
v = v * (visibility_range - min(depth, visibility_range)) / visibility_range
gain = 1 + v                    when v > 0
gain = 1 / (1 - v)              otherwise
```

For land, `material_shading_factor` is 1. Because
`1.5 * 28.8 / 128 = 0.3375`, every nonzero integer land difference reaches the
clamp immediately. The exact gains are therefore:

| Oriented land delta | Edge gain |
| ---: | ---: |
| less than 0 | `1 / 1.3 = 0.769230...` |
| 0 | `1` |
| greater than 0 | `1.3` |

If both current edges brighten, the top-left pixel gets `1.3^2 = 1.69`. If
both darken, it gets `(1 / 1.3)^2 = 0.591716...`. Opposite signs cancel at the
corner. Pixel channels still clamp to 255 after multiplication.

The modification is a plain multiplicative RGB adjustment. It is not a blur,
convolution, or texture lookup.

Only north and west are needed because each shared block boundary is processed
once. A same-height comparison produces a neutral factor. This is the direct
reason flat terrain does not get a visible block grid.

Clean-room pseudocode:

```text
fill the N x N block square with its resolved color

for each stored edge in [north, west]:
    delta = current_ground_y - neighbor_ground_y
    delta = orient_delta_for_sun_quadrant(delta)
    gain = bounded_step_response(delta)
    multiply the one-pixel edge by gain
```

At Amelix zoom 2, `N = 4`. The result is a solid 4 x 4 block interior plus a
selective one-pixel contour at real height steps.

The quadrant comes from `floor((abs(round(sunDirectionDegrees)) mod 360)/90)`.
Its sign rules are:

| Quadrant | Approximate angle | North delta | West delta |
| ---: | ---: | --- | --- |
| 0 | 0-89 degrees | unchanged | inverted |
| 1 | 90-179 degrees | unchanged | unchanged |
| 2 | 180-269 degrees | inverted | unchanged |
| 3 | 270-359 degrees | inverted | inverted |

The default 120-degree sun direction is quadrant 1. Therefore neither the
north nor west signed difference is inverted: a current ground height above
its north or west neighbor brightens that stored edge, while a lower current
height darkens it. The rounded-angle boundary is technically at each
half-degree, so the ranges in the table are descriptive rather than a claim
about floating-point endpoint inclusion.

Source: `TerrainShader.ApplyShadingOnPixel` and `TerrainShader.AdjustLightness`.

### Zoom 0

**Fact.** At one pixel per block, `TerrainShader.CalcShading` uses a directional
3 x 3 weighted height kernel. The result changes the whole block pixel. There
is no space for an internal contour at this zoom.

### Zoom 3 and above

**Fact.** Starting at zoom 3, `ApplyShade` switches the local relief pass to
`TerrainShader.ApplyHqShadow`. Despite its name, this is not the long sun-ray
shadow pass. It compares all eight neighbors and applies precomputed directional
grayscale masks from embedded 3 x 3 atlases named `shadow2.png` through
`shadow128.png`.

The mask strength grows with the absolute height difference and is bounded.
Lower neighbors brighten the current block edge; higher neighbors darken it.
This branch does not use the sun angle. It acts as an ambient beveled relief at
large pixels-per-block values.

**Important:** the published Amelix maximum zoom is 2, so this high-zoom mask
branch cannot be the source of its visible 4-pixel block contours.

## Directional cast shadows are subpixel

**Fact.** Cast shadows are a separate pass controlled by `UseShadows`.
`ShadowCaster` precomputes a voxel-DDA ray path for every subpixel position
inside a Minecraft block. `TerrainRendererState.ApplyShade` then evaluates the
light level at those subpixel positions.

At zoom 2, one block has 16 possible shadow samples. A diagonal shadow edge can
therefore cut through the 4 x 4 block interior even when its material fill is a
single color. This explains how uNmINeD can show more than one effective visual
sample per block without using a full block texture.

The caster traces from the rendered surface toward the sun. The default sun
angles are direction 120 degrees and altitude 45 degrees. A completely blocked
ray is mixed with the original color using the configured shadow strength; the
default strength is 40%, so full occlusion retains 60% of the unshadowed RGB.

At those default angles, the unit vector toward the sun is approximately:

```text
(-0.353553, +0.707107, -0.612372)
```

The general convention for positive altitude `A` and direction `D` is:

```text
receiver_to_sun = (
    cos(A) * cos(D),
    sin(A),
   -cos(A) * sin(D)
)
```

World `+X` is the output's right direction. World `+Z` is the output's down
direction because Z selects the image row. Thus direction 0 points toward
image-right, 90 toward image-up, 180 toward image-left, and 270 toward
image-down. At the published direction 120, rays travel from a receiver toward
image-up-left; the cast shadow extends in the opposite direction,
image-down-right (`+X,+Z`).

Direction and altitude are configurable as `SunDirectionAngle` and
`SunAltitudeAngle` in a map-settings file. The CLI has no dedicated angle
flags. Without a map-settings file, as in the published updater, their defaults
are 120 and 45 degrees. The caster clamps altitude to the inclusive 12-85
degree range before constructing the vector.

For an `N x N` block image, the horizontal ray origins are pixel centers:

```text
x = (pixel_x + 0.5) / N
z = (pixel_z + 0.5) / N
y = 255 / 256
```

At zoom 2, X and Z are therefore `0.125, 0.375, 0.625, 0.875`. The occupancy
traversal translates this precomputed relative path by the runtime integer
`blockY`. It does not rebuild the path from the runtime fractional `subY`. The
`255/256` offset starts just below a voxel's top boundary and avoids an
exact-boundary self-hit. The origin voxel `(0,0,0)` is removed from the
precomputed relative path.

This distinction creates an important models-off compatibility quirk. The
normal solid-color renderer writes `(TopY + 1) * 256` to the pixel height map.
The shadow pass decodes that value as `blockY = TopY + 1` and `subY = 0`.
Because the occupancy DDA still uses its precomputed relative Y of `255/256`,
its effective origin is:

```text
TopY + 1 + 255/256
```

Its first tested voxel is therefore at world Y `TopY + 2`. In contrast, the
model/textured renderer writes `TopY * 256 + 255`, giving an effective
occupancy origin of `TopY + 255/256` and first tested voxel Y `TopY + 1`.
`TopY` is the actual occupied block coordinate; it is not an upper-boundary
coordinate.

The caster also constructs a runtime geometric point at
`blockY + subY/256`. That point is `TopY + 1.0` in the solid-color case, but it
is used only for block-model intersection tests. It does not control ordinary
3D-opacity voxel traversal. Block models are disabled on the published
solid-color path, so the effective occupancy origin above is the relevant one.
This appears physically high by almost one block, but it is the observed
reference behavior that a parity implementation must reproduce. The shadow
map's occupied run coordinates and maximum Y remain ordinary world block Ys;
only the receiver height passed to the ray traversal is shifted.

The voxel traversal is a supercover DDA:

```text
for each axis:
    step = sign(direction)
    t_delta = 1 / abs(direction)
    t_max = distance along ray to the next integer voxel boundary

repeat until the relative Y cell is above 256:
    t = min(t_max_x, t_max_y, t_max_z)
    emit every voxel touched at that crossing
    advance each axis whose t_max equals t
```

If a ray starts exactly on an integer boundary and moves in the negative
direction, the initial cell is the cell on the negative side. At tied crossings
the traversal emits all face-, edge-, or corner-touching voxel combinations.
This supercover behavior prevents light leaks through diagonal contacts.

Runtime traversal can end earlier. It stops when world Y exceeds the composite
shadow map's maximum occupied elevation, or when X/Z leaves the composite map.
A per-chunk maximum-height lookup also skips empty high ray segments without
ending the ray.

For solid-color blocks above zoom 1, the implementation first probes all four
corners. It probes a top, bottom, left, or right edge only when one of that
edge's corners hit shadow-map occupancy. It records hit columns from the top
and bottom and hit rows from the left and right. It probes interior pixels only
at intersections of those recorded columns and rows inside their bounds. A
"hit" here means any occupied shadow voxel was encountered, including partial
opacity; it does not mean only a fully black result. With block models enabled,
or at `N <= 2`, it scans every output pixel.

**Fact.** `TerrainRendererService.StartRenderAsync` disables the ray caster
above zoom 5. The published zoom 2 path is within the supported range.

The shadow-map modes are:

- `Heightmap`, exposed by CLI values `true` and `2d`;
- `Blockmap`, exposed as `3d`;
- `BlockmapWithOpacity`, exposed as `3do`;
- `BlockmapWithBlockstate`, selected internally at high zoom for model-aware
  shadow tests.

The 3D opacity path gives water and foliage different shadow opacity. With
opacity smoothing enabled, transmission is also scaled by the ray's travel
distance through a voxel. Multiple translucent hits multiply their remaining
light.

More exactly, the modes test a ray sample as follows:

- `2d`: the ray is blocked when a sampled column's top elevation reaches the
  sampled voxel Y;
- `3d`: solid and empty vertical runs are tested, and any solid hit is opaque;
- `3do`: vertical runs carry opacity. Water defaults to 10% opacity and leaves
  to 60%; ordinary blocks carry 100%. Transmission multiplies across hits.
  With default opacity smoothing, each voxel opacity is also multiplied by the
  distance between its DDA entry point and the next emitted entry point,
  divided by `sqrt(2)`. Only entries with a following entry get a nonzero
  stored length. Tied supercover entries can also have zero length because
  they share one crossing point.

The exact `3do` accumulation for a nonzero opacity byte `b` is:

```text
if b == 255:
    return light = 0 immediately

effective_opacity = (b / 255) * segment_length
light = light * (1 - effective_opacity)
if light <= 0:
    return 0
```

There is no explicit clamp on `effective_opacity`. Fully opaque solids bypass
smoothing, so a short chord never turns an opaque block into a partial shadow.
The default final RGB gain is `0.6 + 0.4 * light`. The shadow-strength setting
is clamped to 10-90%; the public export uses its default 40%.

**Fact for the published Amelix export.** The repository's update script passes
`--shadows 3do`, `--zoomin 2`, and `--showgrid false`. This removes the earlier
ambiguity: the reference uses the 3D opacity shadow map, not the 2D heightmap or
fully opaque 3D mode. See the immutable first-party
[export script](https://github.com/ForestOfLight/AmelixSMPViewer/blob/80763d20d7ff182a9f4c9a4ca64f38023ab2341c/UpdateSMPViewer.py).

Sources: `ShadowCasterPool.GetSunAngle`, `ShadowCaster`,
`ShadowRayCast.GetIntersectedBlocks`, `TerrainRendererState.ApplyShade`, and
`ShadowmapChunkProcessorRequest.Prepare`.

### Deterministic zoom-2 shadow acceptance cases

These cases were checked by invoking the inspected caster directly against a
synthetic shadow-map interface. They isolate cast shadows by disabling local
elevation shading. The direct probe uses `blockY=0, subY=255`; it is a DDA
oracle, not the integrated models-off height-map path described above. Matrix
columns are its four output X samples, and rows are its four output Z samples.
`#` means the ray encounters the stated opaque block.

One opaque block at world `(X=0,Y=1,Z=-1)` gives:

```text
####
.###
.###
....
```

One opaque block at `(-1,1,-1)` gives:

```text
##..
##..
##..
....
```

Every `#` has ray light 0 and default final RGB gain 0.6. Every dot remains at
gain 1. These masks also exercise the corner/edge/interior shortcut and match
the full 16-ray result.

Replacing the north opaque block with foliage opacity byte 153 produces these
ray-light values before the final 40% shadow-strength mix:

```text
0.936603  0.636603  0.484259  0.484259
unhit     0.809808  0.657464  0.657464
unhit     0.983013  0.830669  0.830669
unhit     unhit     unhit     unhit
```

For example, ray light 0.484259 becomes final RGB gain
`0.6 + 0.4 * 0.484259 = 0.793704` before byte truncation.

For an integrated solid-color receiver whose actual top block is Y=0, the same
three masks require their synthetic occluders one block higher: north at
`(0,2,-1)` and northwest at `(-1,2,-1)`. An occluder at Y=1 is below the first
tested occupancy voxel and does not cast this models-off shadow. A synthetic
`TerrainRendererState` invocation confirmed the full chain for `TopY=64`: the
stored height was `16640`, decoded as `(blockY=65, subY=0)`, and the first
shadow-map query was Y=66. The equivalent topY-based trace first queried Y=65.

### Shadow columns preserve vertical air gaps

**Fact.** The published `3do` shadow map is not a surface height field. For
each world X/Z column it stores alternating occupied vertical runs and empty
gaps. Every occupied run carries one opacity byte. The generator walks actual
block-state runs from top to bottom, removes blocks tagged `#shadowless`, and
encodes every Y gap between the remaining runs as air.

This distinction matters for roof overhangs. A roof block at Y=3 does not make
Y=2, Y=1, and Y=0 occupied merely because it is the column's top block. A ray
below the roof can pass through the air gap. A height field that extrudes the
top block down to the ground produces a materially different silhouette.

Models-off stairs and slabs remain coarse in the other direction. Their tags
classify them as blocking, not shadowless, and the `3do` format does not store
their model or collision shape. Every stair or slab state therefore occupies
its complete integer voxel with opacity 255. Top and bottom slabs, stair
orientation, and stair shape do not change the shadow voxel. Air above and
below that voxel is still preserved.

A deterministic column acceptance case is:

| World Y | Source column | Expected `3do` hit byte |
| ---: | --- | ---: |
| 3 | one roof stair or slab | 255 |
| 2 | air below overhang | 0 |
| 1 | air below overhang | 0 |
| 0 | one ordinary ground block | 255 |
| -1 | air or below test extent | 0 |

The clean-room encoded behavior is one opaque run of length 1 at top Y=3, an
air gap of length 2, then one opaque run of length 1 at Y=0. A ray sample at
Y=2 or Y=1 must remain fully lit unless another X/Z column intersects it. A
height-field implementation will fail this test by reporting an occluder.

Waterlogged blocks are converted to water for this shadow map before the
shadowless test, so their occupied voxel uses water opacity rather than the
original block's default opacity.

Sources: `ShadowmapChunkProcessorRequest.ProcessChunk`,
`TerrainDbBlocksToSliceBlocksConverter`, `ShadowMapWithOpacity.Generate`, and
`ShadowMapWithOpacity.IsHit`.

### Exact foliage shadow classification

Visible foliage tint and cast-shadow foliage opacity use different tag sets.
The exact default `#leaves` name patterns are `**leaves`, `**leaves?`,
`**leaves_?`, `*:*Leaves`, `*:*Leaves?`, `**foliage`, and `*:leaves*`. They
include ordinary species leaves, `azalea_leaves`, and `cherry_leaves`. Those
blocks are blocking flora and get the configured foliage shadow opacity. The
default is 60%, converted with truncation to byte 153:

```text
shadowByte = trunc(clamp(percent * 255 / 100, 0, 255))
```

The renderer's foliage-color selector is broader: it covers `#leaves`,
`#vine`, and `#bush`. The shadow settings provider tests only `#leaves`.
Therefore vines, plain azalea, flowering azalea, and big dripleaf may receive
foliage-like visible styling but do not receive byte 153 from the foliage
shadow setting. Unless another tag changes them, they retain the ordinary
opaque shadow byte 255. Bamboo is blocking flora too, but it is not `#leaves`
and is also opaque in this path.

The default `#shadowless` list contains grass, seagrass, kelp, flowers,
saplings, stems, sprouts, candles, torches, rails, and carpets. The shadow-map
converter removes these before it makes vertical runs. Leaves are not on that
list, so all leaf species remain shadow casters. Species-specific visible
colors do not change this: pink cherry leaves, fixed-color birch leaves, and
fixed-color spruce leaves all still use byte 153. Water uses the same formula
with the 10% default and becomes byte 25. A waterlogged state is changed to the
water block before the shadowless check, so byte 25 wins for that voxel.

This distinction is important for tree-shadow matching: do not derive shadow
opacity from the visual foliage-tint selector. Use the narrower `#leaves`
classification for 60%, the explicit shadowless set for 0%, water for 10%,
and 100% for the remaining occupied blocks.

Sources: the bundled MIT `default.blocktags.minecraft.js`,
`SliceGeneratorBlockStateSettingsProvider`, `TerrainRendererOptions`,
`ShadowmapChunkProcessorRequest.ProcessChunk`, and
`TerrainDbBlocksToSliceBlocksConverter`.

### Tile-boundary behavior

Local elevation contours receive a one-block input halo. Cast shadows receive
a larger independent halo: the render block rectangle is inflated by 256
blocks in every horizontal direction, then rounded outward to 256-block shadow
map tiles. Adjacent output requests reuse these shadow-map tiles and compose
them before shading.

At altitude 45, a ray that rises the full 256-block vertical limit moves at
most 128 blocks in X and about 221.7 blocks in Z for direction 120. The
256-block halo therefore covers the full default ray. A receiver translated to
`(64,0)` with its north occluder translated to `(64,-1)` must reproduce the
first 4 x 4 mask above even though X=64 starts the next native zoom-2 tile. The
same translation test at Z=64 checks a row/tile boundary.

At the minimum configurable altitude of 12 degrees, a full-height ray can move
about 1,204 blocks horizontally. The fixed halo cannot contain that whole ray.
Leaving the composite map ends traversal and preserves the light accumulated
so far, so very long low-sun shadows can truncate. This limitation does not
apply to the published 45-degree default case.

Sources: `TerrainRendererChunkProcessorRequest.CreateShadowmapRequests`,
`TerrainShaderState`, `CompositeShadowMap`, and `ShadowCaster`.

## Biomes: no spatial blur in the inspected Bedrock path

**Fact.** The terrain renderer requests a biome for each visible `SliceBlock`
and performs direct style and tint lookup through
`IndexedBiomeTintsProvider`. It does not average neighboring biome colors.
`FlattenedWorldChunk.GetTint`, used by the inspected Minecraft chunk path,
returns zero rather than a preblended tint image.

The default Bedrock tint table provides discrete grass, foliage, and water RGB
values by biome. The default stylesheet can also replace these tints with
classic hard-coded biome families such as dark forest, savanna, taiga, swamp,
badlands, and ocean variants.

Therefore:

- blocky biome boundaries can reflect the world's biome storage resolution;
- blurring those boundaries is not required to match uNmINeD;
- the smooth large-scale appearance mainly comes from elevation color and
  lightness, not biome convolution.

### Exact Bedrock biome resolution

The legacy Bedrock `Data2D` value must be exactly 768 bytes. uNmINeD takes its
256 biome bytes from offset 512 and addresses them as `z * 16 + x`. Each byte
is a numeric biome ID. The bundled number map resolves common IDs as follows:

A minimal orientation test puts a nondefault ID at byte
`512 + (7 * 16 + 3)`. It must be returned for local `(x=3,z=7)`, not
`(x=7,z=3)`. This asymmetric case detects a per-chunk transpose that can make
otherwise continuous biome boundaries look blotchy.

| Numeric ID | Registered biome name |
| ---: | --- |
| 0 | `minecraft:ocean` |
| 1 | `minecraft:plains` |
| 2 | `minecraft:desert` |
| 4 | `minecraft:forest` |
| 5 | `minecraft:taiga` |
| 6 | `minecraft:swampland` |
| 12 | `minecraft:ice_plains` |
| 24 | `minecraft:deep_ocean` |
| 29 | `minecraft:roofed_forest` |
| 35 | `minecraft:savanna` |
| 186 | `minecraft:meadow` |

An unmapped number becomes `unknown:<number>` and falls back to the provider's
default tints: grass `#8eb971`, foliage `#71a74d`, and water `#3f76e4`.

Modern Bedrock `Data3D` biome palettes are loaded after `Data2D` and select the
section-palette layout when present. Palette entries are still numeric IDs
resolved through the same number map. The modern index is per voxel in
`x,z,y` bit order, not a neighboring-column average. The visible slice keeps
the biome read for the top voxel of its block-state run. Block state does not
change the numeric-ID mapping, although state-sensitive style selectors can
still change the final material style.

More exactly, the accepted Overworld section-Y window is fixed at `-4..19`,
and the first 512 bytes of the `Data3D` value are skipped before biome storage
is read. This implementation does not independently loop over 24 Y numbers.
It walks the chunk's already sorted block-section array, ignores null or
out-of-window sections without consuming biome bytes, and assigns the next
biome storage to each existing in-window section. In a contiguous Overworld
chunk that starts at section -4, each consumed stream slot `n` therefore maps
to section `n - 4`, up to the chunk's highest existing section. If all 24
sections exist, slots 0 through 23 map to -4 through 19. A sparse or
differently based block-section array does not have an explicit
`slot = sectionY + 4` safeguard.

A storage header of `0xff`, or any header whose low bit is zero, stops the
whole biome-storage loop; it is not treated as one missing slot followed by
more slots. Otherwise `bitsPerBiome = header >> 1`. Zero bits means a
one-entry constant palette with no packed data or palette-length field.
Nonconstant storage has 4,096 aligned little-endian 32-bit-packed palette
indexes, followed by a little-endian signed 32-bit palette length and that many
little-endian signed 32-bit numeric biome IDs. The exact local voxel index is:

```text
(x << 8) | (z << 4) | y
```

Thus X is major, Z is middle, and Y is minor. Each coordinate is local 0..15.
The number-map lookup happens after palette decoding; a stored numeric ID is
not the registry's later dense runtime index.

#### Modern numeric IDs 178 through 192

The renderer's stored-Data3D map is `vanilla.biomenumbers.bedrock.txt`. Do not
substitute `vanilla.cubiomesids.bedrock.txt`: that separate biome-generator
map assigns different numbers, including 183 for deep dark and 185 for cherry
groves. The stored palette mapping and default models-off behavior are:

| ID | Registered name | Direct grass / foliage / water tint | Default classic match | Exact grass base / generic foliage / visible water |
| ---: | --- | --- | --- | --- |
| 178 | `minecraft:soulsand_valley` | `#bfb755` / `#aea42a` / `#905957` | none | `(167,160,74)` / `(98,92,23)` / `(25,107,229)` |
| 179 | `minecraft:crimson_forest` | `#bfb755` / `#aea42a` / `#905957` | none | `(167,160,74)` / `(98,92,23)` / `(25,107,229)` |
| 180 | `minecraft:warped_forest` | `#bfb755` / `#aea42a` / `#905957` | none | `(167,160,74)` / `(98,92,23)` / `(25,107,229)` |
| 181 | `minecraft:basalt_deltas` | `#bfb755` / `#aea42a` / `#905957` | none | `(167,160,74)` / `(98,92,23)` / `(25,107,229)` |
| 182 | `minecraft:jagged_peaks` | `#80b497` / `#60a17b` / `#0e63ab` | none | `(112,158,132)` / `(54,90,69)` / `(25,107,229)` |
| 183 | `minecraft:frozen_peaks` | `#80b497` / `#60a17b` / `#0e63ab` | cold/frozen water only | `(112,158,132)` / `(54,90,69)` / `(8,70,215)` |
| 184 | `minecraft:snowy_slopes` | `#80b497` / `#60a17b` / `#0e63ab` | none | `(112,158,132)` / `(54,90,69)` / `(25,107,229)` |
| 185 | `minecraft:grove` | `#80b497` / `#60a17b` / `#0e63ab` | none | `(112,158,132)` / `(54,90,69)` / `(25,107,229)` |
| 186 | `minecraft:meadow` | `#83bb6d` / `#63a948` / `#0e63ab` | none | `(115,164,95)` / `(55,95,40)` / `(25,107,229)` |
| 187 | `minecraft:lush_caves` | `#8eb971` / `#71a74d` / `#44aff5` | none | `(124,162,99)` / `(63,94,43)` / `(25,107,229)` |
| 188 | `minecraft:dripstone_caves` | `#8ab689` / `#6da36b` / `#44aff5` | none | `(121,159,120)` / `(61,92,60)` / `(25,107,229)` |
| 189 | `minecraft:stony_peaks` | `#9abe4b` / `#82ac1e` / `#0e63ab` | none | `(135,166,65)` / `(73,97,16)` / `(25,107,229)` |
| 190 | `minecraft:deep_dark` | `#91bd59` / `#77ab2f` / `#44aff5` | none | `(127,166,78)` / `(67,96,26)` / `(25,107,229)` |
| 191 | `minecraft:mangrove_swamp` | `#6a7039` / `#8db127` / `#3a7a6a` | swamp land, foliage, and water | see swamp exception below |
| 192 | `minecraft:cherry_groves` | `#b6db61` / `#b6db61` / `#5db7ef` | none | `(159,192,85)` / `(102,123,54)` / `(25,107,229)` |

For ordinary rows, "grass base" is both the small-grass result and the
grass-block input before the later elevation overlay. It is the direct grass
tint multiplied by gray 224 with byte truncation. Generic foliage similarly
uses gray 144. The default classic wildcard disables direct water tint, which
is why most visible-water values in the last column are `(25,107,229)`.

ID 191 is the only land-family match in this numeric range. The substring
`swamp` selects the classic swamp rules, which disable its direct tints. Its
exact grass-block base, small-grass color, generic-foliage color, and water
color are `(94,99,53)`, `(100,107,45)`, `(60,65,21)`, and `(75,102,82)`.
The words `crimson_forest` and `warped_forest` do not select the Bedrock dark
forest rule, because that selector specifically requires `roofed_forest`.

ID 192's registered name is the plural `minecraft:cherry_groves`. Its biome
does not select a classic family. The block `minecraft:cherry_leaves` is a
separate block-name exception: it disables biome foliage tint and uses the
fixed HSL color `(330,85%,75%)`, which converts by truncation to
`(245,137,191)`. This fixed pink affects visible color only; the block remains
foliage for cast-shadow opacity. In the separate biome-color display mode,
deep dark is `(3,31,41)` and cherry groves is `(255,145,200)`; those colors are
not normal terrain tints.

The bundled Bedrock tint values most relevant to village and comparison areas
are:

| Biome | Grass tint | Foliage tint | Water tint |
| --- | --- | --- | --- |
| plains | `#91bd59` | `#77ab2f` | `#44aff5` |
| desert | `#bfb755` | `#aea42a` | `#32a598` |
| forest | `#79c05a` | `#59ae30` | `#1e97f2` |
| taiga | `#86b783` | `#68a464` | `#287082` |
| snowy plains (`ice_plains`) | `#80b497` | `#60a17b` | `#14559b` |
| savanna | `#bfb755` | `#aea42a` | `#2c8b9c` |
| swamp (`swampland`) | `#6a7039` | `#6a7039` | `#4c6559` |
| meadow | `#83bb6d` | `#63a948` | `#0e63ab` |
| ocean / deep ocean | `#8eb971` | `#71a74d` | `#1787d4` |
| dark forest (`roofed_forest`) | `#507a32` | `#59ae30` | `#3b6cd1` |

For the models-off solid-color path, a generic foliage tint is multiplied by
gray `(144,144,144)` and a generic grass tint by `(224,224,224)`, with each
channel truncated after multiplication by `tint / 255`. For example, plains
small grass becomes `(127,166,78)` and generic plains foliage becomes
`(67,96,26)` before later lighting. The equivalent forest results are
`(106,168,79)` and `(50,98,27)`.

The effective common color paths before elevation lightness, water-depth
effects, local contours, and cast shadows are:

| Biome family | Grass block | Small grass | Generic foliage | Visible water |
| --- | --- | --- | --- | --- |
| plains | height blend over `(127,166,78)` | `(127,166,78)` | `(67,96,26)` | `(25,107,229)` |
| desert | height blend over `(167,160,74)` | `(167,160,74)` | `(98,92,23)` | `(25,107,229)` |
| forest | height blend over `(106,168,79)` | `(106,168,79)` | `(50,98,27)` | `(25,107,229)` |
| snowy plains | height blend over `(112,158,132)` | `(112,158,132)` | `(54,90,69)` | `(25,107,229)` |
| meadow | height blend over `(115,164,95)` | `(115,164,95)` | `(55,95,40)` | `(25,107,229)` |
| savanna | `(172,163,82)` | `(172,163,82)` | `(92,87,39)` | `(25,107,229)` |
| taiga | `(121,163,117)` | `(73,137,66)` | `(43,89,43)` | `(25,107,229)` |
| swamp | `(94,99,53)` | `(100,107,45)` | `(60,65,21)` | `(75,102,82)` |
| dark forest | `(70,107,45)` | `(93,142,61)` | `(50,106,26)` | `(25,107,229)` |
| ocean / deep ocean | height blend over `(124,162,99)` | `(124,162,99)` | `(63,94,43)` | `(25,86,229)` |

`ice_plains` does not contain the words `cold` or `frozen`, so its water uses
the ordinary inland classic color. Frozen rivers and frozen/cold oceans select
the cold water color instead.

ID 1 (`minecraft:plains`) follows the plain tint-derived values shown in the
table. Its grass block starts from the same `(127,166,78)` result as small
grass, then receives the altitude color overlay. The swamp foliage definition
passes `26 * 0.65` to an integer stylesheet-builder parameter; the bundled
Jint runtime converts 16.9 to 17. Its exact HSL input is therefore
`(66,50%,17%)`, producing `(60,65,21)` rather than a value based on 16%.

There are two important exceptions:

- the enabled elevation-color gradient is applied after biome tint on ordinary
  `#ground` grass blocks. Its brown mountain overlay has alpha 0 at sea level
  and rises to alpha 255 at mountain level. Grass blocks therefore blend away
  from the direct biome result with altitude; small grass and generic leaves
  do not receive this elevation-color overlay;
- classic family rules explicitly disable the direct tint for savanna, taiga,
  dark forest, and swamp. Dark-forest grass block, small grass, and generic
  foliage resolve to `(70,107,45)`, `(93,142,61)`, and `(50,106,26)` before
  elevation lightness and shading. Spruce, birch, and cherry leaves also have
  explicit species colors and do not use biome foliage tint.

Sources: the bundled MIT `vanilla.biomenumbers.bedrock.txt`,
`vanilla.biometints.bedrock.txt`, `vanilla.cubiomesids.bedrock.txt`,
`cubiomes.biomecolors.bedrock.txt`, and `default.stylesheet.minecraft.js`, plus
`BedrockChunkExtractor.Load3DBiomesFromData`,
`FlattenedSectionData.GetBiomePaletteIndex`, `BlocksToTerrainDbConverter`,
`BiomeNumberMap`, `HslColorConverter`, and
`TerrainRendererState.GetBlockColor`.

## Water

**Fact.** Water uses several independent depth effects:

- `WaterVisibilityRange`, default 12 blocks;
- `WaterBlendingStrength`, 30%, with fade start 0 and range 12;
- `WaterDarkeningStrength`, 50%, with start 6 and range 22;
- `WaterShadingStrength`, 50%, with effective fade start 0 and range 12;
- 10% water opacity in the published `3do` cast-shadow map.

`ElevationMapGenerator` accumulates consecutive water depth up to the visibility
range. Local relief compares `surface elevation - water depth`, which
approximates the bed rather than treating every water surface as identical.
This lets underwater terrain influence water shading while the visible water
surface remains flat.

Let `D` be consecutive water depth and `d = min(D, 12)`. For visible depth not
clipped by the range (`D <= 12`), the stored water alpha is:

```text
blend = floor(255 * 0.30) = 76
base_alpha = 255 - blend = 179
alpha(D) = floor(179 + min(D - 1, 12) / 12 * 76)
```

| D | Alpha | RGB darkening gain | Maximum local contour magnitude |
| ---: | ---: | ---: | ---: |
| 1 | 179 | 1.000000 | 0.1375 |
| 2 | 185 | 1.000000 | 0.1250 |
| 3 | 191 | 1.000000 | 0.1125 |
| 4 | 198 | 1.000000 | 0.1000 |
| 5 | 204 | 1.000000 | 0.0875 |
| 6 | 210 | 1.000000 | 0.0750 |
| 7 | 217 | 1.000000 | 0.0625 |
| 8 | 223 | 0.977273 | 0.0500 |
| 9 | 229 | 0.954545 | 0.0375 |
| 10 | 236 | 0.931818 | 0.0250 |
| 11 | 242 | 0.909091 | 0.0125 |
| 12 | 248 | 0.886364 | 0.0000 |

When `D > 12`, the visibility range clips the depth and the color is made fully
opaque instead of using the table. The renderer alpha-composites a translucent
water color over lower non-water slice runs until the column is opaque, then
forces the final rendered block alpha to 255.

The published defaults enable classic biome coloring. Its wildcard water rule
first disables direct biome water tint, then later family rules replace the
base color. The exact pre-depth RGB is therefore `(25,107,229)` for ordinary
inland water, `(25,86,229)` for ocean, `(25,127,229)` for warm ocean,
`(25,117,229)` for lukewarm ocean, `(8,70,215)` for cold or frozen water, and
`(75,102,82)` for swamp. The raw water-tint table above is not the visible
water source in the published models-off export.

Water is the foreground in the column composition. For foreground alpha `a`
over an opaque lower block, each output byte is calculated in byte RGB order:

```text
out_channel = floor(water_channel * a / 255)
            + floor(lower_channel * (255 - a) / 255)
out_alpha = 255
```

The implementation uses integer division at each step, so this is not
equivalent to one final rounded weighted average. Consecutive water runs are
skipped during this composition; the first lower non-water run supplies the
background. Depth darkening changes the water RGB before this blend. Local and
cast-shadow shading change the already opaque composite afterward.

The darkening formula is:

```text
dark_gain = 1 - 0.50 * min(max(0, d - 7), 22) / 22
```

The zoom-1/2 contour first halves the land contour because water shading
strength is 50%, then attenuates it linearly to zero over 12 water blocks:

```text
water_contour_magnitude = 0.15 * (12 - min(D, 12)) / 12
```

At the default 120-degree sun direction, the contour compares
`current(surfaceY - depth)` with the north and west values without sign
inversion. A positive one-block delta brightens the current block's top or
left row; a negative delta darkens it. After the 50% water shading strength
and depth fade, the exact gains are `1 + magnitude` for the positive case and
`1 / (1 + magnitude)` for the negative case. Equal bed height gives gain 1.

Thus a flat water surface does not gain a grid. Relief derives from
`surface Y - water depth`, and its remaining one-pixel bed-height contour fades
away with depth. No water color is spatially mixed with nearby biome colors.

Sources: `TerrainRendererOptions`, `TerrainRendererState.GetTerrainBlockColor`,
`TerrainShader.ApplyDepthTranslucency`, `ElevationMapGenerator`, and
`SliceGeneratorBlockStateSettingsProvider`.

## Optional textures and block models

**Fact.** Full material texture is not part of the default solid-color path.
`UseBlockModels` defaults to false and the CLI exposes it as `--blockrender`.
It is used only at zoom 2 and higher.

When enabled, `BlockRenderImageProvider` rasterizes a Java-style block model
from the top into a 64 x 64 working image. It caches nearest-neighbor variants
at 2, 4, 8, and 16 pixels. `TerrainRendererState.RenderBlockTextured` selects
the variant for the current zoom, applies rotation, flips, alpha composition,
and biome texture tint, then keeps the pixel-level surface height for later
shadow tests.

The Bedrock CLI option `--bedrock-vanilla-pack` supplies a vanilla resource
pack for this path. If a model image is unavailable, rendering falls back to
the resolved style color.

**Fact for the published Amelix export.** Block models are off. The first-party
update script passes neither `--blockrender` nor `--bedrock-vanilla-pack`, while
the option default is false. The pixel evidence agrees: roofs and paths use
whole 4 x 4 style-color blocks; the tiles do not contain repeatable 4 x 4 top
textures, alpha holes, or partial model silhouettes. Low-amplitude variation
inside those blocks is JPEG loss, not proof of a material texture.

If block models were on at zoom 2, a model-backed block could have a repeatable
4 x 4 nearest-neighbor texture or partial occupancy, and its per-output-pixel
surface height could affect the 3D shadow ray origin. None of that model data is
used by this published export.

Source: `TerrainRendererOptions.UseBlockModels`, `CommonRenderOptions`,
`TerrainRendererState.RenderBlockTextured`, and the first-party export script
linked above.

## Published models-off village palette

**Fact.** Tag matching chooses a material family, then matching style rules are
applied in declaration order. A later base-color rule replaces the earlier base
and clears any elevation-color overlay. It does not clear an already assigned
elevation-lightness curve. The bundled stylesheet enables wood, stone, and
masonry coloring by default.

The relevant wood rules first assign generic wood, then let a species-specific
artificial-material rule win. The exact pre-lighting bytes are produced by the
renderer's HSL conversion, which truncates each channel rather than rounding:

| Family | Config HSL | Base RGB bytes |
| --- | --- | --- |
| generic wood | `(42, 50%, 50%)` | `(191, 153, 63)` |
| oak | `(36, 40%, 50%)` | `(178, 137, 76)` |
| spruce | `(30, 45%, 30%)` | `(110, 76, 42)` |
| dark oak | `(30, 55%, 25%)` | `(98, 63, 28)` |

Planks, stairs, and slabs are tagged artificial and wooden. Names such as
`oak_*`, `spruce_*`, and `dark_oak_*` select the corresponding species. The
Bedrock `wood_type` property also selects a species for legacy multi-state
wood products. Modern species-named logs can receive the species color too.
Legacy generic Bedrock `log` states are a weaker case: the bundled tag file has
a TODO for those old names, so they can remain generic wood.

With models off, a species plank, stair, and slab share one solid style color.
Their vanilla texture and partial shape are absent. Integer height contours and
3D cast shadows are the only normal reasons for them to differ spatially.

The relevant village masonry values are:

| Family | Config HSL | Base RGB bytes |
| --- | --- | --- |
| artificial stone/cobblestone/stone-brick | `(0, 0%, 50%)` | `(127, 127, 127)` |
| brick masonry | `(12, 50%, 55%)` | `(197, 105, 82)` |
| earlier generic artificial stone, later overridden | `(0, 0%, 70%)` | `(178, 178, 178)` |

Names such as `cobblestone_*` select the cobblestone masonry family;
`stone_*` products select stone after sandstone, red-sandstone, and end-stone
exclusions. Both relevant default families happen to resolve to the same
50%-gray bytes. Stone-brick products therefore do not get a separate visible
texture or mortar pattern in this export.

Artificial wood and masonry do not request grass, foliage, or water biome tint
and do not receive the land elevation color or lightness tables. Their base RGB
is independent of biome and absolute Y. Natural ground stone is different: it
matches `#rock`, so a later masonry base color clears its elevation-color
overlay but leaves the `land.lightness.elevation` multiplier. Local contours
and cast shadows are applied after all of this color resolution.

The palette operates directly on gamma-encoded byte RGB; there is no
linear-light shading or explicit ICC transform. The published JFIF JPEG has no
embedded ICC profile. Its quality-75 quantization and 4:2:0 chroma sampling
mean the decoded roof pixels will not remain byte-identical to the table.

Candidate aligned tests for the village reference tile at zoom 2:

1. Create a synthetic palette tile with the base bytes above, encode it with
   the same quality-75 4:2:0 path, and use its decoded colors as comparison
   centroids. This isolates JPEG shift from palette error.
2. On quiet, unshadowed 4 x 4 roof blocks, ignore the top row and left column
   when measuring base color. Those samples can contain the selective height
   contour even when the interior is flat.
3. Compare plank, stair, and slab areas of the same species and illumination.
   Their models-off interiors should share one palette centroid; only the
   integer elevation and shadow masks should differ.
4. Compare an artificial gray roof product with natural exposed stone at the
   same local lighting. Only the natural stone should follow the absolute-Y
   lightness curve.
5. Verify material boundaries on 4-pixel block coordinates in decoded luma.
   Chroma can spill across two output pixels, so raw RGB edge width is not a
   reliable geometry test.

Sources: the bundled MIT `default.blocktags.minecraft.js` and
`default.stylesheet.minecraft.js`, `TerrainRendererBlockStylesGenerator.Apply`,
`HslColorConverter.HslToRgb`, and `TerrainRendererState.GetBlockColor`.

### Common non-roof village materials

Beds and wool use the same enabled dye palette. Modern species names and the
Bedrock `[color:<name>]` block state both feed these tags. These are the exact
solid pre-lighting bytes:

| Dye | RGB | Dye | RGB |
| --- | --- | --- | --- |
| white | `(229,229,229)` | orange | `(234,136,71)` |
| magenta | `(232,124,232)` | light blue | `(124,189,232)` |
| yellow | `(232,210,124)` | lime | `(136,234,71)` |
| pink | `(232,124,167)` | gray | `(89,89,89)` |
| light gray / silver | `(127,127,127)` | cyan | `(30,173,173)` |
| purple | `(116,30,173)` | blue | `(30,30,173)` |
| brown | `(173,116,30)` | green | `(87,173,30)` |
| red | `(173,30,30)` | black | `(25,25,25)` |

Plain glass starts from the neutral artificial color `(216,216,216)`. Stained
glass starts from the matching dye color. Both receive default alpha 127
(`floor(50% * 255)`) and are composited over lower column blocks using the
integer foreground-over operation described in the water section. Glass is
still a full shadow voxel in `3do`; visible translucency does not imply
translucent cast-shadow opacity.

The remaining common defaults are:

| Material/tag | Exact pre-lighting RGB | Geometry/shadow note |
| --- | --- | --- |
| hay block | `(216,216,216)` neutral artificial | full opaque voxel; no dedicated hay color |
| wheat, beetroot, carrot, potato, crop, and farmland | `(163,126,40)` | nonblocking, but not shadeless or shadowless |
| generic lamp, lantern, torch, glowstone, or froglight | `(255,234,50)` | torches are shadeless and shadowless; full lights are not |
| soul torch | `(50,254,255)` | shadeless and shadowless |
| redstone torch | `(255,50,50)` | shadeless and shadowless |
| generic uncategorized flower | `(140,214,91)` | shadeless and shadowless |
| red flower | `(244,61,61)` | shadeless and shadowless |
| yellow flower | `(244,226,61)` | shadeless and shadowless |
| blue flower | `(61,171,244)` | shadeless and shadowless |
| purple flower | `(189,61,244)` | shadeless and shadowless |
| white flower | `(242,242,242)` | shadeless and shadowless |
| pink flower family | `(249,184,216)` | shadeless and shadowless |
| cyan flower family | `(19,192,235)` | shadeless and shadowless |
| lily pad | `(30,122,48)` | shadeless and shadowless |

The flower families come from explicit tag patterns, not a full vanilla
species table. A flower that misses those patterns keeps the generic green
flower color. Likewise, hay has no special style in this build and inherits
the neutral artificial color. These details are plausible sources of aligned
village color error if Mapelix uses vanilla map colors instead.

Clean-room palette tests:

1. Put one Bedrock `bed` state and one `wool` state of each color in an
   unshadowed flat synthetic world. Their models-off interiors must have the
   same color-family centroid after identical JPEG encoding.
2. Put clear glass and one stained glass block above a known black and white
   checkerboard. Before shading, clear glass must use alpha 127 and the exact
   integer foreground-over result; it must not use linear-light blending.
3. Put hay, mature wheat, farmland, lantern, and glowstone at the same Y.
   Hay must remain neutral `(216,216,216)`, crop/farmland brown
   `(163,126,40)`, and both full light blocks yellow `(255,234,50)` before
   contours and cast shadows.
4. A torch or flower placed above a receiver must not change the `3do` shadow;
   a lantern or hay block at the same location must.

Sources: the bundled MIT `default.blocktags.minecraft.js` and
`default.stylesheet.minecraft.js`, `SliceGeneratorBlockStateSettingsProvider`,
`TerrainRendererState.GetTerrainBlockColor`, and
`TerrainRendererState.AlphaBlend`.

## Why dirt paths remain distinct

**Fact.** Bedrock `grass_path` and `dirt_path` match `#path`, which is tagged
natural and blocking, then included in `#soil` and `#ground`. Their final base
style is `map.path`: HSL `(36, 50%, 30%)`, approximately RGB `(115, 84, 38)`.
They retain the `#ground` elevation-lightness curve described above.

The later explicit path-color rule also clears the earlier `#ground` elevation
color overlay. This follows from the style accumulator: applying a new base
color clears the existing elevation-color field but does not clear the
elevation-lightness field. A path is therefore a stable brown material whose
brightness still changes gently with absolute Y. It does not receive the
green-to-brown land overlay. This style rule, not fractional geometry, is why
paths remain easy to distinguish in the village tile.

**Fact.** With block models off, path geometry is treated as an ordinary full
voxel:

- the visible surface is the slice's integer `TopY`;
- the elevation map also stores that integer `TopY` because paths are not
  `#shadeless`;
- zoom-2 contours compare that integer Y with neighboring integer Y values;
- a path at the same stored Y as grass gets no relief line at their material
  boundary;
- the 15/16-block collision or model-top height used by Minecraft is not read;
- in the published `3do` map, a path is not `#shadowless` and keeps the default
  255/255 shadow opacity, so the shadow volume treats it as a full voxel.

As a receiver, a path receives the same local contour and per-output-pixel cast
shadow passes as other land. As a caster, it matters only where the integer
voxel can occlude a lower receiver; it does not cast a thin 1/16-height lip.

Related partial-height blocks use the same coarse mechanism in this export:

- farmland is tagged artificial, nonblocking, and `#crops`, with base HSL
  `(42, 60%, 40%)`. It is not shadeless or shadowless, so it still becomes the
  integer elevation surface and a default-opacity shadow voxel. "Nonblocking"
  affects column/cave classification, not fractional render height.
- slabs are tagged artificial and blocking. Their material tags choose their
  style color, but, with models off, top and bottom slabs both use the block's
  integer `TopY` and a full shadow voxel. No half-block surface enters either
  the zoom-2 contour or the ray origin.

Sources: the bundled MIT `default.blocktags.minecraft.js` and
`default.stylesheet.minecraft.js`, `TerrainRendererBlockStylesGenerator.Apply`,
`TerrainDbBlocksToSliceBlocksConverter`, `ElevationMapGenerator`,
`ShadowmapChunkProcessorRequest`, and `ShadowMapWithOpacity`.

## Published tile encoding and comparison effects

**Fact.** The web exporter defaults to JPEG, and the Amelix update script does
not override it. It uses ImageSharp 4.0 with a default `JpegEncoder`; no quality
or color-sampling option is set by the exporter.

The published zoom-2 tile's markers confirm:

- baseline 8-bit JPEG, 256 x 256 pixels;
- luminance and chrominance quantization tables for quality 75;
- YCbCr 4:2:0 sampling: Y uses a 2 x 2 sampling factor while Cb and Cr use
  1 x 1;
- opaque output; JPEG does not carry the terrain renderer's alpha channel.

This matters for a pixel metric. One Minecraft block is 4 x 4 pixels at zoom 2,
while the JPEG transform works in 8 x 8 luma blocks. A compression block spans
two Minecraft blocks in each direction. Chroma is also subsampled over 2 x 2
output pixels. As a result:

- compare edge position and luminance before raw RGB equality;
- expect chroma to look softer than the geometric contour;
- do not interpret low-amplitude within-block variation or 8-pixel periodicity
  as a material texture;
- decode both images to a common color space before calculating color error.

For formats without transparency, the web exporter starts partial edge tiles
with an opaque background. The Amelix overworld script supplies `#78a7ff`.
Rendered visible columns are already forced opaque after internal water/glass
composition. Missing area outside the clipped world rectangle retains the
background color.

Sources: `WebMapExportOptions`, `WebMapExport`, `ImageSharpSerializer`, the
bundled `SixLabors.ImageSharp 4.0.0` assembly, the published tile's JPEG SOF and
DQT markers, and the first-party export script.

## Cave contour is a separate feature

**Fact.** `TerrainShader.ApplyCaveEnhancements` draws black boundary lines when
cave height or underground/open status changes. It is enabled by default. At
very large positive zoom it can draw a second line. This should not be confused
with normal overworld height contours or directional shadows.

## Useful CLI and map-settings controls

The official CLI exposes these comparison controls directly:

```text
--area=b(x,z,width,height)
--zoom=-5..3
--shadows=false|true|2d|3d|3do
--blockrender
--bedrock-vanilla-pack=FILE
--mapsettings=FILE
--chunkprocessors=N
--topY=N --bottomY=N --gndxray --night
```

The published Amelix updater's exact common options are:

```text
--zoomout 6 --zoomin 2 --shadows 3do --showgrid false
```

It supplies overworld background `#78a7ff`, uses the default JPEG output, and
does not pass a map-settings file, block-render flag, or Bedrock vanilla pack.

Relevant saved renderer-setting names found in `IRendererSettings` include:

- `Shadows`, `ShadowMode`, `ShadowStrength`;
- `SunDirectionAngle`, `SunAltitudeAngle`;
- `ShadowWaterOpacity`, `ShadowFoliageOpacity`,
  `ShadowOpacitySmoothing`;
- `UseElevationShading`, `UseCaveEnhancements`, `UseBlockModels`;
- `WaterVisibilityRange`, water blending, darkening, and shading start/range/
  strength controls;
- `ColoringMode`, `HeightmapGradient`, `WaterHeightmapGradient`, and
  `WaterDepthmapGradient`;
- altitude limits and glass/barrier opacity.

The CLI can render a deterministic 64 x 64-block image at zoom 2, which is
exactly one published native tile. The current Amelix backup cannot be opened
by this strict LevelDB reader because its manifest references a removed table;
the already-published tile remains the usable oracle for that snapshot.

## Mapelix experiments suggested by the findings

These are behavioral experiments, not a request to copy the implementation.

1. **Match the published zoom-2 contour first.** On a synthetic flat field,
   verify that every block interior and boundary has the same value. On a
   one-block plateau, apply one crisp edge sample only where the height changes.
2. **Separate local relief from cast shade.** Measure them independently. A
   selective edge pass should not be asked to create long diagonal shadows.
3. **Sample cast shade at output-pixel resolution.** For a 4 x 4 block, test
   whether a diagonal occluder produces a stable sub-block shadow edge. This is
   a higher-value fidelity experiment than adding texture noise.
4. **Use absolute elevation styling before biome blur.** Recreate a tunable
   sea-to-mountain color/lightness curve and compare large-scale color bands.
5. **Keep biome smoothing optional.** It is an artistic extension, not an
   uNmINeD matching requirement.
6. **Add water depth as its own signal.** Compare shallow transparency, deep
   darkening, and attenuated relief separately.
7. **Delay the eight-neighbor mask experiment.** It is relevant only if
   Mapelix later serves 8 or more pixels per block; it did not make the public
   Amelix zoom-2 reference.
8. **Use vertical shadow runs, not an extruded surface.** Preserve air below
   roof overhangs and bridges. Keep the published coarse full-voxel treatment
   for models-off stairs and slabs.

The smallest high-value target is thus: solid native block squares, quiet flat
interiors, one selective height contour, and an independent output-resolution
cast-shadow pass.

## Inspection index

The exact methods that support the main findings are:

- `TerrainRendererState<TPixel>.SetColor`
- `TerrainRendererState<TPixel>.RenderBlock`
- `TerrainRendererState<TPixel>.RenderBlockTextured`
- `TerrainRendererState<TPixel>.GetBlockColor`
- `TerrainRendererState<TPixel>.GetTerrainBlockColor`
- `TerrainRendererState<TPixel>.AlphaBlend`
- `TerrainRendererState<TPixel>.ApplyShade`
- `TerrainShader.ApplyShadingOnPixel`
- `TerrainShader.CalcShading`
- `TerrainShader.ApplyHqShadow`
- `TerrainShader.ApplyCaveEnhancements`
- `ElevationMapGenerator.GenerateElevationMap`
- `TerrainDbBlocksToSliceBlocksConverter.GetSliceBlock`
- `ShadowCaster.InternalGetLightLevel`
- `ShadowRayCast.GetIntersectedBlocks`
- `ShadowCasterPool.GetSunAngle`
- `ShadowmapChunkProcessorRequest.Prepare`
- `ShadowMapWithOpacity.Generate`
- `ShadowMapWithOpacity.IsHit`
- `SliceGeneratorBlockStateSettingsProvider.GenerateBlockStateSettings`
- `BedrockChunkExtractor.Load2DBiomesFromData`
- `BedrockChunkExtractor.Load3DBiomesFromData`
- `FlattenedChunkData.GetBiomeNumber`
- `FlattenedSectionData.GetBiomePaletteIndex`
- `BiomeNumberMap.GetBiome`
- `TerrainRendererChunkProcessorRequest<TPixel>.CreateShadowmapRequests`
- `TerrainRendererChunkProcessorRequest<TPixel>.DoneAsync`
- `WebMapExport.RenderZoomOutTiles`
- `ImageSharpSerializer.GetJpegEncoder`
- `TerrainRendererBlockStylesGenerator.Apply`
- `HslColorConverter.HslToRgb`
- `StylesheetCompilationContext.GenerateGradient`
- `StylesheetCompilationContext.GenerateCurveMapping`

This index is for future behavioral verification. It is not a dependency or a
proposal to reuse the proprietary assemblies.
