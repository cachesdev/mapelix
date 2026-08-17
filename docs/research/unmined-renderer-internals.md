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
4. Cast shadows are a separate optional pass. The caster samples rays at image
   subpixels, not once per Minecraft block. At zoom 2, a shadow boundary can
   therefore have up to 4 x 4 positions inside a solid-color block. This is the
   strongest explanation for the extra detail in shaded uNmINeD areas.
5. The broad heatmap look is mostly an absolute-elevation color and lightness
   style. It is not biome blur. The inspected Bedrock path does not spatially
   blend biome colors.

These passes preserve sharp material boundaries. There is no global blur and
no unconditional per-block outline.

## Inspection method and confidence

The official single-file Linux executable was unpacked outside the repository.
ILSpy 11 decompiled its managed assemblies successfully. The behavior below
was traced through named types and methods, and checked against the CLI help,
the distributed default configuration, and the published Amelix zoom-2 tile.

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
defines a cartographic land color gradient from sea level toward mountain
level. It also defines `land.lightness.elevation`, which is brightest near sea
level and gradually darker toward low and high extremes. The compiled gradient
and curve tables use linear interpolation at integer Y values.

This creates smooth color bands over geographic distance because nearby terrain
usually changes height gradually. It can look like a spatial heatmap even
though the renderer looks up each block's own Y independently.

## The selective block contour

### Zoom 1 and 2: the path used by the published Amelix tile

**Fact.** `TerrainRendererState.ApplyShade` calls
`TerrainShader.ApplyShadingOnPixel` for positive zooms below 3.

For each block, that method compares the water-adjusted ground height with the
north and west neighbors. It writes only one row or column inside the block.
The sun-direction quadrant decides whether a given signed height difference is
treated as light-facing or shade-facing.

The response saturates quickly. In the default strength path, a one-block step
is already close to the maximum local adjustment: approximately 1.3 times RGB
on the bright side or its reciprocal on the dark side. The modification is a
plain multiplicative RGB adjustment. It is not a blur, convolution, or texture
lookup.

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

For solid-color blocks above zoom 1, the implementation first probes block
corners and edges. It scans interior subpixels only when the edge results show
a possible shadow boundary. This avoids most `N x N` work on fully lit blocks.

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

**Inference, high confidence.** The published Amelix images visibly contain
directional cast shade, so Forest likely exported with one of the `--shadows`
options or equivalent saved settings. The static export does not publish its
map-settings file, so the exact shadow-map mode is not recoverable from its web
metadata alone.

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

## Water

**Fact.** Water uses several independent depth effects:

- `WaterVisibilityRange`, default 12 blocks;
- a depth-dependent alpha used to blend the water over lower visible blocks;
- gradual darkening beginning at depth 6;
- reduced local elevation shading as depth increases;
- optional low-opacity contribution to cast shadows.

`ElevationMapGenerator` accumulates consecutive water depth up to the visibility
range. Local relief compares `surface elevation - water depth`, which
approximates the bed rather than treating every water surface as identical.
This lets underwater terrain influence water shading while the visible water
surface remains flat.

The default shallow-water blend starts near 70% water opacity and becomes more
opaque with depth. Water beyond the visibility range is opaque. The style's
base water color can come from the exact biome, but it is not spatially mixed
with nearby biome water colors.

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

**Inference.** The public Amelix tile does not look like a uniform full-texture
render, but small model-shaped blocks and the selective shading passes can both
create within-block detail. Without the original map-settings file, the export's
`UseBlockModels` value remains unproven.

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
- `TerrainRendererState<TPixel>.ApplyShade`
- `TerrainShader.ApplyShadingOnPixel`
- `TerrainShader.CalcShading`
- `TerrainShader.ApplyHqShadow`
- `TerrainShader.ApplyCaveEnhancements`
- `ElevationMapGenerator.GenerateElevationMap`
- `TerrainDbBlocksToSliceBlocksConverter.GetSliceBlock`
- `ShadowCaster.InternalGetLightLevel`
- `ShadowRayCast.GetIntersectedBlocks`
- `ShadowmapChunkProcessorRequest.Prepare`
- `TerrainRendererChunkProcessorRequest<TPixel>.DoneAsync`
- `WebMapExport.RenderZoomOutTiles`
- `StylesheetCompilationContext.GenerateGradient`
- `StylesheetCompilationContext.GenerateCurveMapping`

This index is for future behavioral verification. It is not a dependency or a
proposal to reuse the proprietary assemblies.
