# Block light

LOD 0 and 1 carry baked block light in Surface and Caves, with or without a texture
stack. Torches, lanterns, lava, glowstone, campfires, candles and other known vanilla
sources illuminate nearby faces. Saved states distinguish lit and extinguished
blocks, candle counts, charged respawn anchors and copper bulbs. Unknown blocks
emit zero light. The [Bedrock light-emission component](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/blockreference/examples/blockcomponents/minecraftblock_light_emission)
defines the 0–15 range; the source table is in `blocks/block-light.ts`.

## Computation

The existing palette holds each block's emission independently of its visual
material. A descending, typed queue propagates the maximum source value to the
six neighboring cells, losing one level per step. Full opaque cubes and lava
block transmission; opaque emitters still seed their surroundings. Partial
models, glass and water transmit with unit attenuation in this first version.
It does not simulate the exact light opacity of every vanilla block shape.

The existing horizontal source margin is 16 blocks. Cave slices retain full
source sections above and below the visible window, including sources hidden by
the slice. Computation is bounded to potentially visible heights plus 15 blocks
on both sides; the field is sampled in the cell in front of a boundary face or
inside a model's cell for an inset face. Adjacent faces merge only when their
light levels also match. Plants use their own cell's value.

LOD 1 preserves source emission and light opacity before reducing appearances to
cubic voxels, so small sources and their states survive there. LOD 2–5 retain
their previous geometry and self-emission and allocate no block-light field.

## Region format 4

The 40-byte header, height grid and three geometry words per quad are unchanged.
Texture words still follow geometry when header byte 7 bit 0 is set. New bit 1
(`REGION_FLAG_BLOCK_LIGHT`) adds a final byte plane, after all geometry and texture
words: opaque, plants, then translucent, in exactly the same quad order. Each byte
is a value in 0–15. `SceneRegion.blockLight` exposes those three `Uint8Array`s;
decoded arrays view the payload without copying. Absence means zero block light.
Regions without lit faces omit the plane. Partitioning lava moves light and
texture data together with geometry.

At the same quad count, a lit region costs one extra byte per quad: at most
8.33% over 12-byte plain geometry or 6.25% over 16-byte textured geometry, less
including the fixed height grid/header. Different light levels split merged
faces, so the measured total increase also includes additional quads.

Self-lit terrain and lava store zero local fill on their own faces: those shaders
use their existing glow rather than the block-light plane. This avoids splitting
otherwise identical emissive faces by an unused value. Their emission and the
light on every receiving face remain unchanged at both near LODs.

Before choosing this layout, one real detailed region at the version-3 baseline
had 6,113 quads, 81,588 bytes plain and 106,040 bytes textured. An extra byte would
cost 6,113 bytes (+7.49% / +5.76%); an extra word would cost 24,452 bytes
(+29.97% / +23.06%). Texture-only packing would cost no bytes when textured but
cannot cover plain regions, whose texture stream is absent.

Version-3 readers reject version 4. Upgrade the scene server and browser bundle
together. The engine fingerprint includes the format and changed mesher code,
so new metadata names a new revision and cache identity. Request paths, query
parameters, metadata fields and embed API version 5 are unchanged. Hosts that
decode regions directly must handle the optional light plane and bitwise flags.

## GPU and appearance

One auxiliary GPU word combines texture and light data in both display modes:

| Bits | Meaning |
| --- | --- |
| 0–13 | Atlas tile |
| 14–15 | Rotation |
| 16 | Tint |
| 17 | Textured |
| 18 | Cutout |
| 19–26 | Sheet offsets |
| 27–30 | Block light, GPU only |
| 31 | Reserved |

The serialized texture word remains unchanged. Uploading a lit plain quad adds
four GPU bytes; a textured quad reuses its existing word. Unlit plain and distant
geometry allocate no auxiliary buffer. Light stays associated with its face when
water and glass split into rendering batches. Streaming memory budgets count
actual GPU buffers; quad statistics count geometry rather than dividing total
GPU bytes by 12.

Mesh reuse keeps layouts with and without an auxiliary buffer in separate pools,
under the same combined capacity. A mesh never retains a pipeline that expects a
missing vertex buffer after textures change or the camera enters an unlit region.

A flat integer varying reuses the existing flow/texture channel, with no extra
inter-stage variable. Integer transport prevents interpolation from changing
texture flags at high light levels, including faces with texture word zero.

The shader combines a warm local fill with existing illumination and contact
occlusion. Local fill also takes the interpolated corner occlusion, because an
emissive material output bypasses the renderer's ambient-occlusion input. This
keeps recesses readable under strong block light without changing the warm tint
or the brightness of unoccluded faces. Its contribution is weaker in surface
daylight. Sun and sky lights,
shadows, weather, lightning, wet roughness, reflections and source bloom remain
dynamic. The existing cave exploration fill remains. There are no dynamic point
lights and no per-frame light propagation or region rebuilds.

## Validation and measurements

Targeted tests cover emission states, attenuation, competing sources, opaque
walls, row/layer bounds, positive/negative region boundaries, all three
dimensions, LOD 1, cave source margins, serialization, lava ordering and GPU
buffer ownership. A browser regression removes only the uploaded light bits and
compares neighboring floor pixels, in plain/textured modes on WebGPU and WebGL 2.
Another renders original color swatches through the real terrain shaders at
maximum light. It changes only occlusion at fixed world positions and checks
that all four occlusion levels stay ordered, the darkest remains visibly darker,
colors remain distinct, and even white terrain stays below display clipping.

Nether portals emit level 11. A framed portal regression checks levels 10 through
6 on both sides at LOD 0/1, including zero texture words, and the longer light path
around opaque obsidian. The quadratic response makes this light weaker than
level-15 lanterns; this version uses the same warm fill for every source, without
a separate violet halo.

[Measurements](benchmarks/block-lighting-2026-11-18.json) compare the same read-only
copied snapshot against `f3ab898`, alternating seven builds per version, discarding
the first two and reporting the median of five. These are targeted regional
measurements, not a full-world prewarm or peak-memory guarantee.

A [follow-up measurement](benchmarks/block-lighting-review-2026-11-18.json) isolates
the self-lit-face optimization. The Nether LOD-1 sample drops from 27,877 to
27,809 quads and 395,209 to 394,325 bytes: 0.224% less than the first lighting
version, still 38.14% above the no-light baseline. Lava itself drops from 447
to its original 445 quads. Most added quads belong to the surrounding terrain's
different light levels. Warm median construction stays approximately 181 ms in
this paired run; timing comparisons across separate runs are not equivalent.

Lossless storage experiments on the first lighting payload estimated 381,271
bytes with two levels per byte and 390,760 bytes with short run encoding. These
would change the v4 byte-plane contract and its zero-copy decoding for a modest
reduction; neither is enabled. No light levels are quantized or removed from
receiving terrain to reduce geometry.

One value per face deliberately retains visible steps. Corner smoothing is
deferred until geometry, transfer, construction and physical-phone performance
budgets have been reviewed. Desktop frame-rate measurements do not establish
phone performance.
