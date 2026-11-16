# Bedrock block color palette

The palette is generated from the complete registry in the supplied official
`bedrock-samples-v1.26.60.5-full.zip`, independently of any particular world.
Only numeric colors and source bindings are included, not Mojang texture images
or third-party source code. The offline generator reuses `pngjs` and reads
true-color TGA itself; no runtime dependency is added.

## Generation and coverage

Extract the full samples into an ignored directory. From the repository root:

```sh
pnpm --filter @mapelix/prototype exec node scripts/generate-scene-palette.mjs \
  <absolute-path-to-extracted-bedrock-samples> \
  ../mapelix-core/src/appearance/bedrock-colors.ts \
  ../../docs/block-colors-coverage.json
```

The output paths account for `pnpm --filter ... exec` changing directories to
`packages/mapelix-prototype`. Format the output with the existing `oxfmt` tool.

The generator joins `mojang-blocks.json`, `blocks.json` and `terrain_texture.json`,
with explicit bindings for entity-textured beds and other special blocks. It samples
1,276 of 1,466 identifiers using 1,011 image samples. The remaining 190 entries are
listed in the [coverage report](block-colors-coverage.json); many are technical,
Education-only, hidden, or already covered by existing rules. This is a source-binding
count, not a fidelity score.

The catalog-wide regression test permits ordinary visible gray only for these
explicit exceptions: `disc_press` and `icicle` have no block definition or visual
resource in this ZIP, and `unknown` is an engine placeholder. Their appearances
are not invented. Education chemistry/element blocks and hardened glass remain
outside this vanilla gameplay milestone. Add-ons require their own resources;
for example, `tac_guns:workbench` is absent from the vanilla archive.

Colors are alpha-weighted sRGB means, with equal weight for lateral faces.
PNG and raw/RLE true-color TGA are supported. Cropped mattress UVs exclude unused
entity pixels and bed legs. Animated strips produce a stable mean, not an animation.
An input fingerprint and fixed traversal make generation and error reports reproducible.

The generated catalog and complete identifier list are now owned by the portable
`@mapelix/core/appearance` entry. The existing scene `bedrock-colors.ts` path re-exports that same
object. Tuned color and legacy-alias decisions are shared there as well. Regeneration updates the
common source rather than a renderer-specific copy. Classic 2D adaptations are documented in
[2D block colors](2d-block-colors.md).

## Rendering and beds

Existing shapes, materials, shaders, AO, visibility and LOD policies remain.
Samples override rules that conflated ores, copper oxidation, lava/magma,
Nether bricks, soul ground, roots/fungi, wart growth, blackstone variants and
froglights. Existing tuned terrain and foliage colors otherwise stay in use;
fixed cherry, azalea, pale-oak and poplar colors are retained. The archived 2D block-style palette is
unchanged; the production modern 2D profile uses the shared catalog with top-view adaptations.

The scene reader handles Bedrock tag `0x31` as optional block-entity metadata.
It validates bed dyes (0-15), chunk coordinates, dimension and height. The shared
`sectionCells` path applies colors only to actual beds at detailed and coarse LODs;
stale entities cannot repaint other blocks. Missing or malformed metadata retains
the client entity's default white appearance without preventing terrain rendering.
The shared NBT decoder also accepts valid empty End-typed lists used by block entities.

All 16 blankets are sampled independently; oak is retained on the underside.
Different bed dyes and conditional texture states have distinct palette cache keys.
Head/foot geometry and orientation approximations are unchanged.

## Biomes

Every ID in the supplied biome registry has a profile or explicit family fallback:

- Bamboo jungle (48) and hills (49) use jungle climate and their client water colors.
- Pale garden (193), sulfur caves (194) and dappled forest (195) use explicit client
  colors. Unspecified sulfur-cave foliage retains the default.
- Ice caves (196) has no behavior or client resource in this archive. It explicitly
  uses the snowy-tundra color family pending official resources.
- Nether (8) and End (9) retain neutral tints; their dimension atmosphere is separate.

Legacy mutation aliases are preserved. No sky or per-biome fog effects are added.

## Validation and integration

Tests cover sampling, transparent pixels, TGA, cropped entity UVs, regeneration,
all bed dyes, conditional caches, negative coordinates, dimensions, stale/corrupt
metadata and unexpected gray fallback across the complete catalog. Generated
regions exercise all three meshers and all six LODs. Real End validation still
requires a world containing explored End chunks.

The read-only snapshot has 80 bed blocks in four dye colors, all matched to their
stored colors, plus two stale entities that are ignored. Snapshot bytes are checked
unchanged. Historical 2D reference images are not regenerated.

Completed validation: 283 unit tests, eight browser regression tests (generated
fixtures and the real Overworld/Nether snapshot), six catalog captures in automatic
and forced-WebGL modes, builds, type checks and focused formatting. All 90 official
biome IDs have profiles; no other biome colors changed. Regeneration is identical.
Lint retains only two pre-existing sort warnings in `foliage-region.test.ts`.
All 14 snapshot files, including `level.dat`, remain byte-identical. The two
color patches apply in order to `f622e3a` using an isolated temporary index.

Generic base: `d726cfc`. Commit `54c7a6c` establishes the catalog; its successor
completes the remaining work. Integrate them in order on `f622e3a`. No changes touch
`apps/scene-server`, panel/updater code, the embedded interface, base paths, `.bin`
suffixes, dimensions or ceilings. API/viewer version 2 and region format 2 remain.
The prototype mesh revision is 22; the existing server fingerprints compiled engine
JavaScript, so rebuilding produces separate revision/cache entries.

## Separate follow-up topics

The subsequent [block-model and lava lot](block-models-and-lava.md) adds cuboid
models, lava patterns, animation, levels, directional flow and controlled emission
through existing bloom. That document lists supported families and remaining
model/fluid limitations. The color commits above remain independent of that lot.

Still separate:

- Full resource-pack/entity geometry, curved/rotated details, interpolated liquid
  slopes and local light propagation.
- Overworld underground exploration: the cave/gallery view, navigation below the
  surface, altitude controls and bounded visibility/volume budgets. The existing
  Nether ceiling cut remains; no underground visibility or slicing path is added.
