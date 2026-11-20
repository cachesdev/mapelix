# Foliage and banner rendering

Lily pads keep their fixed green color in plain regions. Their grayscale pack
texture takes the same color, including the `lily_pad` alias for Bedrock's
`waterlily`. Vines use the existing foliage biome tint in both modes. Thin plant
textures keep their alpha cutout, independently of the detailed-leaves option.

Standing and wall banners read the saved block entity's `Base` dye. Its order is
reversed into the existing bed/wool palette: Base 0 is black and Base 15 white.
The normal palette identity keeps banners of different colors separate, even in
one subchunk. Negative coordinates, cave slices and the voxel reader use the
same color metadata. Missing metadata falls back to white cloth; malformed
optional metadata does not prevent terrain rendering.

Cloth and wooden supports are separate model parts. The cloth uses a tile cut at
runtime from `textures/entity/banner/banner` in the pack stack. The native
512-square Bedrock sheet holds many pattern cells; only its first cell's cloth
rectangle is sampled. Enlarged sheets and standalone 64-square sheets are also
supported. No pattern cells, pole pixels or transparent gaps enter the cloth tile.
The original file remains in texture notices. Source images are never bundled
with the renderer.

The wooden placeholder in `blocks.json` is never used as cloth. Without an entity
sheet, the banner retains its saved color in textured mode too. The cuboid model
keeps its existing approximate one-block cloth size. Banner pattern layers,
animation and an exact two-block cloth model are outside this change.

Region format **4**, atlas binary format **2** and embed API **5** remain unchanged.
Texture pipeline version **10** rebuilds texture revisions and derived atlas
tiles automatically. A rebuilt scene service regenerates regions through its
normal engine fingerprint; hosts need no new option or data migration.

The generated showcase includes a lily-pad pond, vines on all four sides and
hanging vines, plus all 16 banner base colors both standing and on a wall. Tests
exercise saved dyes, palette separation, color-only fallback, foliage tint and
cutout flags, native and enlarged sheet crops, and atlas notices. Visual checks
cover plain/textured views on WebGPU and WebGL 2.
