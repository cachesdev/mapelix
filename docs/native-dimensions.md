# Native dimensions: Milestone 1

The subsequent [block-model and lava lot](block-models-and-lava.md), after color
commits `54c7a6c` and `855d98f`, retains the server contract below: dimension/ceiling
cache separation and region format 2. Its optional quad extensions keep region
format 2; the prototype mesh revision is `23`. Work starts from `da1c879`.

## Implementation plan

1. Export a browser-safe dimension configuration beside the existing binary format:
   storage IDs, vanilla bounds, biome origin, geometry policy and atmosphere.
2. Apply the configuration to chunk records, biome decoding and region builders.
   Preserve the default Overworld surface path; read full height for Nether and End.
3. Reuse the current greedy meshers with explicit surface/interior visibility policies.
   Keep End void and undersides. Clip Nether roof geometry before meshing and reduction.
4. Pass dimension through the existing worker pool and HTTP adapter; separate all caches.
5. Add viewer selection, URL state, fixed Nether/End lighting and safe streaming disposal.
6. Test decoding, geometry at each LOD, switching and cache isolation. Compare unchanged
   Overworld region bytes and timings on an extracted copy of the committed Mojang fixture.

## Reference study

BedrockMap and its bedrock-level submodule are AGPL-3.0. They remain read-only; no code or
dependencies are copied. The useful architectural observations are dimension-qualified
chunk positions, a dimension-relative Data3D biome origin, and retaining selected source
voxels so newly exposed faces can be rebuilt. Mapelix already has suitable worker ownership,
volume storage, greedy meshing and packed quads, so an incremental geometry policy is the
smaller change than a separate underground mesher.

Vanilla bounds and storage identifiers are cross-checked against the primary implementation
in [Dragonfly](https://github.com/df-mc/dragonfly/blob/master/server/world/dimension.go).
Microsoft documents [data-driven height and void generation](https://github.com/MicrosoftDocs/minecraft-creator/blob/main/creator/Documents/DataDrivenOverworldHeight.md);
custom dimensions and behavior-pack height overrides are outside this milestone.

## Implemented behavior

- One browser-safe profile per dimension: Bedrock ID, bounds, geometry policy, ceiling and
  atmosphere. Data3D biome storage begins at the correct dimension floor.
- Chunk caches and worker pools remain dimension-specific. Both record keys and decoded
  v9 section heights are bounded by the selected dimension.
- Overworld keeps its surface mesher and depth shortcuts. Nether and End read complete
  stored columns, retain interior faces, and avoid replacing deep void with invented rock.
- Nether roof cuts happen before volume description, face generation and LOD reduction.
  All six LODs agree on the cut. End island undersides are retained even at the box floor.
- Existing packed quads, materials, lighting shaders, water, greedy merging, AO, streaming
  and GPU/WebGL renderer remain in use. Nether and End receive fixed atmosphere/lighting.
- Dimension changes retain the renderer and materials, replace the streamer, cancel its
  requests and ignore late responses. Server and browser caches include dimension and ceiling.
- Vanilla poplar foliage has fixed red, orange and yellow colors, and pale oak foliage is
  gray. Poplar wood uses its own palette. This intentionally corrects previously unsupported
  blocks that fell back to generic green leaves or generic wood.

The Nether menu starts at an **exclusive ceiling of Y 96**. This is a fixed default, not
automatic bedrock-ceiling detection. The user changes it manually in 16-block steps; the
request changes when the slider is committed. Y 128 retains the complete roof. The engine
also accepts an explicit ceiling through `buildRegion` independently of this UI.

The leaf coverage audit uses the 16 leaf block identifiers in Mojang's Bedrock samples
v1.26.60.5, including the two legacy identifiers. Ordinary foliage keeps biome tinting;
cherry, pale oak, azalea and poplar keep fixed colors. Poplar and pale oak palette values
were checked against alpha-weighted texture color averages from the supplied official
archive. Its EULA-based license was inspected. No texture assets or third-party source were
copied. The [official texture catalog](https://github.com/Mojang/bedrock-samples/blob/main/resource_pack/textures/terrain_texture.json)
is the reference for the native block families.

## Server contract

A server other than the prototype adapter should follow this contract:

1. Open a `SceneWorld` with `dimension: "overworld" | "nether" | "the-end"`. One instance
   fixes the dimension for its worker pool. The existing default remains Overworld.
2. Accept `dimension` and `ceilingY` on metadata and region requests. Normalize them with
   `contextFromSearch` / `sceneContext` from `@mapelix/scene-prototype/dimensions`.
3. Build with `world.buildRegion({ level, x, z, ceilingY }, signal)`. The ceiling is exclusive,
   aligned to 16, above the dimension floor and at most its exclusive maximum. Invalid
   contexts return HTTP 400.
4. Metadata now includes `dimension`, `ceilingY`, and `dimensions` (the profile list), in
   addition to `name`, `spawn`, and `revision`. The viewer's entry point is Overworld spawn,
   its X/Z divided by eight for Nether, or X 100 / Y 64 / Z 0 for End. These are navigation
   defaults, not discovered portal or player positions. Library `world.info.spawn` is unchanged.
5. Separate cache identities as `revision/dimension/ceilingY/level/x/z`. The existing adapter
   uses mesh revision **20**. Bump a server's cache revision when adopting this output.
6. Add context and revision to every browser region URL. Dispose the previous streamer before
   replacing it and reject its late completions. The binary format remains **version 2**;
   the caller owns dimension/ceiling identity because the header does not contain them.
7. The existing adapter returns HTTP 409 for a stale explicit revision and 499 for cancelled
   builds. Immutable HTTP caching is used only with an explicit valid revision; metadata
   remains `no-store`. Legacy region URLs still default to Overworld.

### Embedded viewer compatibility

The prototype adapter demonstrates the engine with root-relative, extensionless routes.
A host that embeds the viewer with its own routes should keep the following behavior:

- Keep the host's URL builder, configured base path and suffix (such as `.bin`). Append
  `dimension`, `ceilingY` and `revision` using `URLSearchParams`. Apply the configured base
  path to metadata requests as well as region requests, including dimension changes.
- Preserve the existing viewer creation options and URL/fetch configuration when
  `setWorld` creates a replacement streamer. The prototype's root-relative, extensionless
  URLs must not replace the host's configurable URLs.
- Carry both `dimension` and `ceilingY` through metadata, the embedded viewer, scene-server
  routing, region builds and every cache layer. Context must survive renderer/streamer
  replacement and URL restoration.
- Version the host's own embedding interface when exposing dimension switching. This is
  separate from binary `REGION_FORMAT_VERSION`, which remains 2, and mesh revision 20.
- Preserve Overworld defaults and existing transport options. Requests without a dimension
  default to Overworld and ceiling Y 320. Normalize legacy metadata that omits scene context
  to these defaults at the host boundary.

Prototype adapter examples (the existing extensionless routes):

```text
GET /world.json?dimension=nether&ceilingY=80
GET /regions/0/-1/0?dimension=nether&ceilingY=80&revision=<metadata-revision>
```

Host request shape, retaining its configured base path and suffix:

```text
GET <configured-base>/world.json?dimension=nether&ceilingY=80
GET <configured-base>/regions/0/-1/0.bin?dimension=nether&ceilingY=80&revision=<metadata-revision>
```

A host smoke test should use a non-root configured base path and verify metadata,
region loading, dimension switching, ceiling changes, cache separation and legacy
Overworld requests.

`MAPELIX_SCENE_WORKERS` applies to each lazily opened dimension pool. Visiting all three
dimensions can therefore create three pools; a shared global worker budget is future work.

## Validation and performance

Validation used Node 24.14.1 and pnpm 11.21.0 on Windows, an extracted copy of the committed
Mojang fixture, generated multi-dimension LevelDB logs, and the user's disposable world
snapshot. That snapshot contains Overworld and Nether; the user confirmed it has no End.
Database files were opened read-only. All 13 database file sizes/modification timestamps and
the `level.dat` SHA-256 remained unchanged after validation.

- All 69 engine unit/integration tests pass, covering dimension-qualified decoding, height/biome offsets,
  malformed section bounds, cache contexts, materials, missing blocks/chunks and all six LODs.
- Four golden region SHA-256 values from `da1c879` remain exact on the committed Mojang world
  at LOD 0, 1, 3 and 5. The shared prototype's 145 tests and ten committed visual scenes pass.
- All six viewer unit tests pass, covering fixed lighting, Overworld restoration, cancellation/late responses,
  dimension/ceiling memory caches, separate workers and persisted caches after server restart.
- Chrome tests exercise the HTTP adapter and Overworld/Nether/End switching, URL restoration,
  roof changes and reuse of the same canvas. They run with normal GPU selection and forced
  WebGL fallback on both generated fixtures and the real snapshot. Real End geometry remains
  unvalidated because this snapshot has no End chunks.
  All eight browser cases pass: four on generated data and four on the real snapshot.
- The focused engine/viewer build, type, lint and unit checks pass. Repository-wide type,
  lint and unit checks also pass. Full focused quality gates passed on the LF-normalized
  validation checkout; formatting-only normalization was then excluded from the commit.
  A full `quality` run on a CRLF Windows checkout can fail formatting checks in otherwise
  unchanged files, including the existing 2D visual-check application. No 2D source was changed.

The final CPU comparison alternates one-worker baseline and candidate builds, discards three
warm-up runs and reports the median of ten samples per version. Coordinates are region (-1, 0)
at each level in the supplied Overworld snapshot:

| LOD | Main median | Final median | Change |
| --- | ---: | ---: | ---: |
| 0 | 31.92 ms | 31.86 ms | -0.2% |
| 1 | 190.24 ms | 203.79 ms | +7.1% |
| 3 | 510.40 ms | 515.52 ms | +1.0% |
| 5 | 570.44 ms | 576.97 ms | +1.1% |

These are small local samples, not a throughput guarantee. The dimension-only implementation
was byte-identical to main on all four real-world regions too. The subsequent poplar color
correction intentionally changes real-world region colors and their hashes; those differences
must not be treated as a regression or used to rewrite the older Mojang golden hashes.

Before the intentional foliage correction, a settled 1200x800 Overworld comparison produced
the same 89 drawn regions, 1.43 million quads, 16.3 MiB of quad memory and 144 displayed FPS
in both versions. Images were 97.72% within five RGB levels per pixel; water and plants animate,
so these are not deterministic screenshot goldens. The display-limited FPS is not an uncapped
GPU benchmark. A final 1440x900 capture of the corrected forest showed 144 FPS and 1.36 million
quads; its view differs and should not be compared numerically to the earlier view.

At Nether region L0 (-1, 0), main emitted one roof quad at Y 127..128. The new default emits
10,673 quads across Y 0..96. A settled real Nether view displayed 0.72 million quads at 144 FPS.
Generating actual interiors costs more than generating a roof: this is a different workload.
The unchanged streaming and cache paths amortize that cost. Full production-scale Nether
memory/throughput testing remains future work.

Raw timings, hashes, memory observations and capture statistics are retained in
[`benchmarks/native-dimensions-2026-11-12.json`](benchmarks/native-dimensions-2026-11-12.json).

## Underground follow-up and limitations

| Approach | Reuse and cost | Decision |
| --- | --- | --- |
| Extend the existing meshers with explicit visibility/range policies | Reuses materials, packed faces, AO, workers and LOD reduction; must bound the requested vertical volume before enabling detailed Overworld caves. | Implemented for Nether/End; preferred next step for bounded Overworld exploration. |
| Separate underground geometry path | Could choose a different sparse representation, but currently duplicates decoding, face rules, AO, merging and LOD seams without measured benefit. | Reconsider only if bounded-volume measurements show the current meshers cannot meet the target. |

General Overworld underground exploration, arbitrary-height cuts, vertical slice planes and
near-camera underground volume budgets are not implemented in Milestone 1. Nether cuts are
horizontal and section-aligned. Coarse LODs can close narrow caves under their normal voxel
reduction. Fixed dimension atmosphere does not yet transition between Nether biomes.

Custom resource-pack loading, custom dimensions, behavior-pack height overrides, entities,
resource-pack meshes and a general unknown-block texture palette remain outside this milestone.
Unknown blocks keep the existing deterministic solid fallback. The committed native leaf
catalog test does not automatically discover future Minecraft block additions.

Orthographic/top-down views can reuse this renderer later. They, further atmosphere effects,
global cache/worker budgeting and texture-pack adaptation remain follow-ups. No camera,
meshing or deployment rewrite was introduced.

## Changed files

Based on `da1c879`.

The change spans the dimension model, chunk/biome readers, the existing region builders and
meshers, block appearances, viewer/server context handling, test fixtures, browser tests,
benchmark options and documentation. A complete file inventory is maintained below.
Formatting-only line-ending changes in 39 otherwise unchanged files were restored before
staging and are excluded from this commit.

### File inventory

Content changes and new files:

- `README.md`
- `apps/prototype-viewer-3d/README.md`
- `apps/prototype-viewer-3d/package.json`
- `apps/prototype-viewer-3d/playwright.config.ts`
- `apps/prototype-viewer-3d/src/lib/server/scene-world.test.ts`
- `apps/prototype-viewer-3d/src/lib/server/scene-world.ts`
- `apps/prototype-viewer-3d/src/lib/view-url.ts`
- `apps/prototype-viewer-3d/src/lib/viewer/atmosphere.test.ts`
- `apps/prototype-viewer-3d/src/lib/viewer/atmosphere.ts`
- `apps/prototype-viewer-3d/src/lib/viewer/region-streamer.test.ts`
- `apps/prototype-viewer-3d/src/lib/viewer/region-streamer.ts`
- `apps/prototype-viewer-3d/src/lib/viewer/world-viewer.ts`
- `apps/prototype-viewer-3d/src/routes/+page.svelte`
- `apps/prototype-viewer-3d/src/routes/regions/[level]/[x]/[z]/+server.ts`
- `apps/prototype-viewer-3d/src/routes/world.json/+server.ts`
- `apps/prototype-viewer-3d/tests/dimensions.e2e.ts`
- `apps/prototype-viewer-3d/tests/setup-world.ts`
- `apps/prototype-viewer-3d/turbo.json`
- `apps/prototype-viewer-3d/vitest.config.ts`
- `docs/benchmarks/native-dimensions-2026-11-12.json`
- `docs/native-dimensions.md`
- `packages/mapelix-scene-prototype/README.md`
- `packages/mapelix-scene-prototype/package.json`
- `packages/mapelix-scene-prototype/scripts/benchmark-regions.mjs`
- `packages/mapelix-scene-prototype/src/blocks/block-appearance.test.ts`
- `packages/mapelix-scene-prototype/src/blocks/block-appearance.ts`
- `packages/mapelix-scene-prototype/src/dimensions.test.ts`
- `packages/mapelix-scene-prototype/src/dimensions.ts`
- `packages/mapelix-scene-prototype/src/index.ts`
- `packages/mapelix-scene-prototype/src/leveldb/world-database.test.ts`
- `packages/mapelix-scene-prototype/src/mesh/chunk-voxels.ts`
- `packages/mapelix-scene-prototype/src/mesh/region-volume.ts`
- `packages/mapelix-scene-prototype/src/mesh/voxel-level-mesher.ts`
- `packages/mapelix-scene-prototype/src/mesh/voxel-mesher.ts`
- `packages/mapelix-scene-prototype/src/mesh/voxel-region.ts`
- `packages/mapelix-scene-prototype/src/node/foliage-region.test.ts`
- `packages/mapelix-scene-prototype/src/node/region-builder.test.ts`
- `packages/mapelix-scene-prototype/src/node/region-builder.ts`
- `packages/mapelix-scene-prototype/src/world/chunk-source.test.ts`
- `packages/mapelix-scene-prototype/src/world/chunk-source.ts`
- `packages/mapelix-scene-prototype/src/world/data-3d-biomes.ts`
- `packages/mapelix-scene-prototype/test/dimension-fixture.ts`
- `packages/mapelix-scene-prototype/turbo.json`
- `pnpm-lock.yaml`
