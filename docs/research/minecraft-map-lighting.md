# Minecraft top-down map lighting research

Date: 2026-08-16

## Decision

For Mapelix's normal (untextured) surface map, treat the terrain as a *continuous
height field* for lighting, but retain a block-sized material-color field. Do not
apply a gradient, edge bevel, or seeded texture inside every block. A uniformly
flat region of one material and one biome must produce uniform RGBA pixels at
every native resolution. Draw light changes only when the height field, the
material, the biome tint, or a real cast-shadow occluder changes.

This is not a proposal to use Minecraft's in-game smooth-lighting algorithm
directly. That algorithm shades exposed **3-D model faces**. Mapelix renders a
top-down height/color raster, so a height-field hillshade plus a directional
heightmap shadow is the matching representation.

## What is proven about uNmINeD

uNmINeD is closed source; no public renderer implementation was found. Therefore
the exact formula, filters, shadow-map resolution, and zoom construction are
**not known**. The following is the public, first-party evidence:

- The default renderer fills every block square with one color. Its optional
  textured mode fills the square with the in-game block texture; it is still not
  a 3-D block renderer. Texture mode starts at zoom-in 4:1. This directly
  explains why a same-material, same-biome, equal-height field can look
  continuous in the default view: there is no documented per-block lighting
  gradient to reveal its boundaries. [uNmINeD 0.19.58 release note](https://unmined.net/2026/03/20/unmined-0-19-58-dev-modded-worlds/)
- The earlier documented shadow renderer was a heightmap algorithm and did not
  handle bridges, overhangs, or holes. Later releases describe high-resolution
  shadow mapping and a raycasting-shadow fix; they also say `#shadowless`
  grass/flowers stay flat. That proves a terrain/occluder shadow pass exists,
  but does **not** disclose its formula. [uNmINeD 0.14.9](https://unmined.net/2021/10/18/unmined-0-14-9/),
  [uNmINeD 0.19.8](https://unmined.net/2023/07/19/unmined-0-19-8-dev/),
  [July 2023 release archive](https://unmined.net/2023/07/)
- uNmINeD supports biome tinting and says its cartographic elevation gradient
  is compatible with it. This proves those are selectable map layers/features,
  not that the base default uses per-block normal lighting. [uNmINeD 0.19.8](https://unmined.net/2023/07/19/unmined-0-19-8-dev/)
- uNmINeD's author describes the intended style as cartographic, simplified,
  and based on a balanced palette rather than a reproduction of the game. The
  author says disabling the elevation gradient makes the map look flat. This
  strongly supports a region/elevation style layer, not artificial within-block
  contrast. [uNmINeD biome work-in-progress](https://unmined.net/2021/11/25/wip-biomes/)
- uNmINeD has an explicit “Flat grass” option that suppresses elevation shading
  and shadows cast by tall grass, flowers, and saplings. Its altitude settings
  adjust the elevation gradient and other style elements to the world's mountain
  height and sea level. Thus it distinguishes ground/elevation from decorative
  surface cover rather than treating the topmost block in every column as an
  equally solid terrain sample. [uNmINeD January 2022 releases](https://unmined.net/2022/01/),
  [uNmINeD 0.16.3](https://unmined.net/2021/12/05/unmined-0-16-3-world-height/)
- The release note does not state whether each web-map zoom is freshly rendered
  or generated from another level. Do not infer that behaviour from appearance.

## Relevant proven renderer designs

### Overviewer: actual textures and face lighting

Overviewer is an isometric sprite renderer, not a top-down height-map renderer.
It makes cached block sprites from actual textures, transforms top and side
faces, and composes zoomed-out tiles by shrinking four detailed tiles. This is
good evidence for texture selection and image-pyramid construction, but not a
drop-in lighting model for Mapelix. [Overviewer design document](https://github.com/overviewer/Minecraft-Overviewer/blob/master/docs/design/designdoc.rst)

Its normal lighting uses Minecraft's stored `SkyLight` and `BlockLight` values.
For opaque blocks it assigns light from the neighbouring blocks that touch each
visible face. Its smooth-lighting mode assigns light at every face vertex by
averaging suitable surrounding samples and interpolates across the face. The
document explicitly identifies the resulting dark corners as an ambient-
occlusion side effect. On a large open, flat top surface this method does not
invent a block-outline bevel; the face lighting field is shared/interpolated
between neighbours. [Overviewer lighting design](https://github.com/overviewer/Minecraft-Overviewer/blob/master/docs/design/designdoc.rst#lighting)

Overviewer's grass block generator loads `grass_block_top.png` and overlays a
biome-tint texture, so a production texture path should use actual resource-pack
top textures plus Minecraft-compatible tint masks, rather than generated grain.
[Overviewer `textures.py`](https://github.com/overviewer/Minecraft-Overviewer/blob/master/overviewer_core/textures.py)

### BlueMap: resource models, per-vertex AO, and biome tint indices

BlueMap creates an actual 3-D model from Minecraft resource-pack block-state and
model JSON, assigns face texture UVs, and culls hidden faces. Its resource-model
renderer gets sky/block light from the face neighbour, applies a block's
resource-pack tint index, and writes ambient-occlusion values per vertex. Its
AO routine tests adjacent occluding blocks and reduces a vertex by 0.25 per
occluder (clamped to three). This is the correct approach for a 3-D scene and
again shows that AO belongs at geometric corners, not as a universal 2-D
per-block border. [BlueMap `ResourceModelRenderer.java`](https://raw.githubusercontent.com/BlueMap-Minecraft/BlueMap/master/core/src/main/java/de/bluecolored/bluemap/core/map/hires/block/ResourceModelRenderer.java)

BlueMap's own configuration documentation makes the same separation: model
geometry determines neighbour-face culling and which blocks occlude AO; dynamic
grass, foliage, and water colors come from biome colors. [BlueMap mod rendering
configuration](https://github.com/BlueMap-Minecraft/BlueMap/wiki/Configuring-mods)

## Consequences for Mapelix

At the time of diagnosis, the renderer did the thing the reference designs avoid in a flat
top-down map: it constructs a separate shaded micro-image for every block.
`subBlockRelief()` adds four edge treatments and `materialTexture()` adds seeded
per-block noise when `pixelsPerBlock > 1`; `calculateShade()` also contains a
per-cell `stepRelief` term. Those operations make a regular 8x8 block lattice
visible even if all samples have equal height. See
[`render.ts`](../../packages/mapelix/src/render.ts).

Recommended implementation order:

1. Remove seeded `materialTexture()` and `subBlockRelief()` from the normal
   untextured style. The fast, decisive regression fixture is a same-height
   grass rectangle at `(-2950, -2630)`: it must be pixel-uniform inside a
   biome/material region at 1x, 2x, 4x, and 8x.
2. Replace the discrete `stepRelief` with a *single raster field* derived from
   height. Expand block heights with nearest sampling at the output resolution,
   compute central-difference gradients there, then evaluate one directional
   Lambert/hillshade term. This confines the response to one or two pixels at a
   real height discontinuity. Do not blur or bilinearly interpolate the final
   light field: that removes the grid by destroying legitimate high-frequency
   terrain edges.
3. Classify decorative cover separately from terrain before forming the height
   field. Tall grass, flowers, saplings, and similarly non-occluding cover
   should normally use their supporting ground height and cast no terrain
   shadow. This matches uNmINeD's documented Flat grass treatment.
4. Keep cast shadows as a separate directional heightmap/raycast pass. Only a
   positive height clearance along the sun ray should darken the receiver;
   shadow strength must not depend on the receiver's block boundary. Use an
   overlap/read margin so neighbouring tiles compute identical border pixels.
5. Keep biome tint as a color multiplier/mask applied before illumination.
   Match the resource-pack texture tint mask when real textures are introduced;
   do not replace a texture with coordinate-seeded noise.
6. If textured mode is added, sample actual top-face assets at zooms where a
   block has enough pixels. Generate farther zoom-out levels from the rendered
   child tiles with a proper box/linear resample and premultiplied-alpha
   compositing. Overviewer documents this image-pyramid pattern. Do not expect
   texture mode to be boundary-free: real per-block texture repetition is a
   deliberate visual feature.

## Verification criteria

- A uniform same-material / same-biome / same-height 16x16 field has exactly
  one RGBA value in each native-output image (except transparent pixels).
- A height step changes a bounded one- or two-pixel edge band while each flat
  block interior remains uniform.
- Changing only the height of one source cell changes pixels in a bounded,
  directionally plausible relief/shadow neighbourhood; it cannot add a
  repeated outline to untouched equal-height cells.
- The same world-space border pixels agree when rendered from either adjacent
  tile, including biome tint and cast-shadow margins.
- At texture-capable zooms, a known grass-top texture is recognisable; at
  untextured zooms, there is no procedural per-block grain.

## Scope and confidence

All external sources above are first-party project documentation or source code.
Statements labelled as uNmINeD facts are limited to its official release notes.
The recommended Mapelix algorithm is an engineering inference from those facts
and from the open-source renderer implementations; it is not a claim that it
reproduces uNmINeD's unpublished code exactly.
