# Block models and animated lava

This follow-up to `54c7a6c` and `855d98f` changes the engine and the viewer
shaders, geometry batches and ray collider.

## Sources and supported geometry

The supplied official `bedrock-samples-v1.26.60.5-full.zip` provides the block
registry, state names, straw-bed geometry, lava colors and animation timings.
Microsoft also documents the [vanilla state catalog](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/blockreference/examples/blockstateandtraitlistings).
The ZIP license refers to the Minecraft EULA. No Mojang images or third-party
implementation code are distributed. Geometry and shaders are original;
reference data are numeric bounds, colors and timings.

Detailed LOD 0 geometry includes:

- Straight, inner and outer stairs, in four directions and both vertical halves.
  Stored corner states take priority; older palettes derive compatible corners
  from neighbors, including the blocking-side rule.
- Both door halves, shared facing/open state, hinge side and open/closed
  trapdoors. Doors remain color-shaded panels, without texture-mask cutouts.
- Connected fences, gates, short/tall walls, panes and iron bars. Stored
  connections take priority; fallback uses the existing margin across chunk
  and region boundaries.
- Hollow scaffolding, bed mattresses/legs/pillows with existing per-bed dyes,
  non-flat straw-bed cubes and chorus branches on all six axes.
- Lantern bodies, pots, axis-aligned rods/chains, ladders, candle groups, bitten
  cakes, hollow cauldrons and hoppers. These are cuboid representations:
  curved chains, tilted details, cutout textures and flat straw fringes remain
  approximations. Other small blocks retain their previous appearance.

Fully covered model faces are culled. The ray collider and vertex shader use
identical bounds, removing former cube collisions from empty stair halves and
open gates. Farther LODs retain the cubic voxel policy and material/color
reduction. This bounded cuboid catalog is not a resource-pack interpreter.

## Lava

Lava and flowing lava have an explicit subtype, independent of RGB. Magma and
lamps retain their materials. `liquid_depth` sets height in sixteenths; falling
lava and blocks with lava above fill their column. Horizontal animation follows
the local height gradient in eight directions; vertical faces scroll down.
Surfaces remain flat in each cell. Interpolated liquid slopes and physical
fluid simulation are not implemented.

The shared lava material uses an original world-space procedural pattern with
dark patches and hot veins. The ZIP calibrates colors and 16/10-tick still/flow
time scales. The pattern crosses merged quads and region boundaries without
restarting and filters fine detail at distance. GPU animation needs no region
rebuilds or per-frame requests.

Emission peaks on hot veins and feeds existing bloom. Global bloom, exposure,
other lights and dimension atmospheres are unchanged. This adds a surface halo,
without local light propagation or per-block point lights on nearby walls.
Lava adds one shared material pair and at most one draw per lava region.
The engine groups lava at the opaque stream's end; the viewer uses subarray
views without duplicating the buffer. Internal lava faces are culled and lava
retains the Overworld sky barrier for terrain below its surface.

## Format and integration contract

The header remains version **2**, with **12 bytes per quad** and original
material IDs. Optional extensions use reserved/non-plant bits:

- Word 0 bit 31 marks a model cuboid. Word 1 bits 24-31 encode the bounds ID as
  `(floor(id / 6) << 3) | (id % 6)`, retaining legal legacy sprite values 0-5.
  Other fields provide a full-box fallback for old readers.
- Non-model word 1 bit 27 marks lava; bits 28-31 encode horizontal flow.
  The base material stays `Emissive`, giving old readers static emission.
- The append-only catalog has 180 bounds, stored as shared scalar uniforms.
  Its encoding permits 192 entries. Never reorder IDs. With Node 24, run
  `node packages/mapelix-scene-prototype/scripts/generate-model-bounds.mjs`,
  then format the output with the existing formatter.

New viewers also read old regions without flags. The actual reader from
`855d98f` parses new real-world regions during validation. Old viewers approximate
model parts as boxes and do not animate lava.

The prototype mesh revision advances from 22 to **23**. A server that fingerprints
the compiled engine gets a new revision and cache identity. Keep the cache key
`(world revision, dimension, ceilingY, level, x, z)` and any configured URL base
path or suffix. Metadata, viewer options and URL construction do not change.

## Validation and limits

Unit tests cover the catalog, state identity, stair volumes, door halves,
hinges, connections, beds, legacy fields, ray hits, zero-copy lava batches,
flow octants, material reduction, internal face culling and sky visibility.
Generated LevelDB records exercise models in all dimensions and lava at all
six LODs. Browser tests compile WebGPU and forced WebGL shaders and compare a
lava crop over time with an unchanged camera.

### Lava coordinate correction

The follow-up to `10a9a7c` fixes a shader-only defect: converting a negative
floating-point noise seed directly to an unsigned integer collapsed the pattern
in parts of the world. Lattice coordinates now pass through signed integers
before their unsigned bits are mixed. Both axes contribute independently, so
negative coordinates retain texture and animation without mirroring the world.
The palette, glow, geometry, region format and cache keys are unchanged; only
the viewer must be rebuilt and reloaded. No region cache purge or embed API
version change is needed.

A browser regression uses actual pixel contrast and frame differences in all
four coordinate quadrants, across Overworld, Nether and End, with WebGPU and
forced WebGL 2. The test reproduces the flat negative-X pool before the fix.
It asserts the renderer backend as well as texture and animation, using only
generated disposable worlds.

Follow-up validation: viewer build, type checks, lint, 8 viewer unit tests and
8 browser tests pass. Local automatic rendering used WebGPU; the second browser
project forced WebGL 2. The regression checks 24 pool/backend combinations.

The read-only user snapshot has Overworld/Nether without explored End chunks.
End validation uses generated fixtures. All 14 source files are fingerprinted
before and after validation. Targeted measurements compare against `855d98f`;
they do not replace full-server prewarm and memory checks.

Overworld underground exploration, cave/gallery navigation and its visibility
budgets remain separate. The existing Nether ceiling behavior is preserved.

Completed checks: **327 unit tests**, **6 generated-fixture browser tests** and
**4 real-snapshot browser tests**, with builds, type checks, lint and targeted
formatting. The two catalog-only browser cases are intentionally skipped on the
real snapshot. Its 14 files remain byte-identical. Catalog regeneration is also
byte-identical; the only lint warnings are the two existing foliage-test sort
warnings. Historical formatting in the native-dimension report is preserved.

[Targeted measurements](benchmarks/block-models-lava-2026-11-13.json) alternate
seven in-process builds per version, discard two and report the median of five.
On the selected detailed Overworld region, payload grows from 71,616 to 81,480
bytes and median build time from 34.16 to 35.56 ms (+4.1%). The detailed Nether
region grows from 86,664 to 107,340 bytes and from 36.22 to 43.83 ms (+21.0%).
Detailed models, lower liquid surfaces and flow distinctions increase geometry.
These local samples are not full-server prewarm or peak-memory guarantees;
Deployments should measure those budgets on their own server.
