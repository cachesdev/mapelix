# uNmINeD zoom-2 shadow sampling gates

## Result

This is a clean-room behavior trace for uNmINeD CLI
`0.20.1-dev+2c464b0e75bbe9cc105fe2046151005c48ec75fc`. The inspected binary has
SHA-256 `eb19961e575303fe4880f531e2a6ef2759aeabe23582c7c229d24365a9656fa6`.
No world data was read, and no proprietary source is reproduced here.

At native zoom 2, one solid-color block is a 4 x 4 output square. When shadows
are enabled and block models are disabled, uNmINeD does not always cast all 16
rays. It uses corner hits to admit edge rays, then uses edge hits to admit
interior rays. This is an occupancy-based shortcut, not interpolation from
corner light values.

The shortcut applies only when all of these conditions hold:

- a shadow caster exists;
- the pixel factor is greater than 2;
- block models are disabled.

At zoom 2 the pixel factor is `2^2 = 4`, so the published models-off path uses
the shortcut. If the factor is 1 or 2, or block models are enabled, every pixel
is sampled.

## Models-off receiver Y is one voxel above `TopY`

The models-off zoom-2 path carries the receiver height through an integer
fixed-point heightmap:

1. `TerrainRenderRequest.Prepare` allocates one height entry per output pixel
   and initializes it to a sentinel.
2. The chunk processor passes that same heightmap to `TerrainRendererState`.
3. The models-off `RenderBlock` path supplies `(TopY + 1) * 256` to `SetColor`.
4. `SetColor` copies that value to all 16 pixels of the factor-4 block.
5. `ApplyShade.ProcessPixel` decodes the high bits as `blockY = TopY + 1` and
   the low byte as `subY = 0` before it calls `ShadowCaster`.

This differs from the textured/model path. `RenderBlockTextured` records
`TopY * 256 + 255`, which decodes as `blockY = TopY`, `subY = 255`.

There is one important implementation distinction inside `ShadowCaster`:

- its block-model `groundPoint.Y` uses the decoded value directly, so the
  models-off fixed-point value would give `TopY + 1.0`;
- its solid/opacity voxel traversal does **not** use `subY`. The caster
  precomputes every relative DDA path from local Y `255/256`, then adds only
  `blockY` to each relative voxel coordinate.

Block models are disabled in the path studied here, so the second behavior is
the one that controls the opacity lookup. Its effective ray origin is therefore
`TopY + 1 + 255/256`, not `TopY + 1.0`. The first opacity-map voxel tested is
the same X/Z column at Y `TopY + 2`. The original cell is omitted from the
precomputed path.

For Mapelix's direct DDA, parity means adding one only to the receiver origin:

```text
originY = receiverTopY + 1 + 255/256
```

Do not add one to opacity-run `minY`/`maxY`, surface fallback heights, or the
maximum terrain Y. Those values remain world voxel coordinates. This receiver
shift prevents lower voxels from being tested as if they were above the visible
surface.

This is a reference-renderer bug rather than a different `TopY` convention.
Mapelix reproduces it by default so lossless comparisons remain meaningful.
The opt-in `correctReferenceBugs: true` mode starts the ray at the physical top
face, `TopY + 1`, while keeping the stored opacity runs unchanged.

### Integrated synthetic confirmation

A reflection harness exercised the actual chain from request preparation to
the opacity-map callback for one models-off block at zoom 2. No world was
opened. With receiver `TopY = 64`, all 16 stored values were `16640`, which is
`(64 + 1) * 256`. `ApplyShade` decoded `blockY = 65`, `subY = 0`; the
block-model point was Y `65.0`, the opacity traversal's effective origin was Y
`65.99609375`, and its first lookup was Y `66`.

The same integrated harness then used receiver `TopY = 0` and a north
occluder. An opaque voxel at Y 1, a one-block rise, produced no volume shadow:

```text
....
....
....
....
```

Moving only that north voxel to Y 2 produced the established factor-4 mask:

```text
####
.###
.###
....
```

Opacity byte 153 at north Y 2 produced the same hit footprint. With base red
240 and shadow strength 0.4, its rendered red/gain matrix was:

```text
233/0.970833  205/0.854167  190/0.791667  190/0.791667
240/1.000000  221/0.920833  207/0.862500  207/0.862500
240/1.000000  238/0.991667  223/0.929167  223/0.929167
240/1.000000  240/1.000000  240/1.000000  240/1.000000
```

The byte-domain gains include final RGB truncation. The underlying ray-light
values are the higher-precision foliage matrix later in this report.

## Exact factor-4 order and gates

Coordinates below are `(x,z)`, where X increases to the image right and Z
increases down the image.

All corners are sampled first, in this order:

1. top-left `(0,0)`;
2. top-right `(3,0)`;
3. bottom-left `(0,3)`;
4. bottom-right `(3,3)`.

If all four corner rays have `hit = false`, sampling stops for that block. An
edge or interior ray that would independently hit is therefore intentionally
not found.

If at least one corner hits, edge sampling uses these independent gates:

| Edge   | Gate                            | Samples when admitted |
| ------ | ------------------------------- | --------------------- |
| top    | top-left OR top-right hit       | `(1,0)`, `(2,0)`      |
| bottom | bottom-left OR bottom-right hit | `(1,3)`, `(2,3)`      |
| left   | top-left OR bottom-left hit     | `(0,1)`, `(0,2)`      |
| right  | top-right OR bottom-right hit   | `(3,1)`, `(3,2)`      |

The horizontal loop visits X=1 and then X=2. At each X it samples the admitted
top edge first and the admitted bottom edge second. The vertical loop then
visits Z=1 and Z=2. At each Z it samples the admitted left edge first and the
admitted right edge second. A closed gate makes no ray call because the gate is
short-circuited.

For each inner X, uNmINeD records a **hit column** when either the top or bottom
edge ray at that X hits. For each inner Z, it records a **hit row** when either
the left or right edge ray at that Z hits. It also records the first and last
hit column and row as inclusive loop bounds.

An interior coordinate is sampled only if both its column and row were
recorded. In other words, the interior candidates are the Cartesian
intersections of the admitted hit-column and hit-row sets. The bounds only
limit iteration; they do not fill gaps. X is the outer interior loop and Z is
the inner loop.

In compact form, let `C` be the inner X values with a top-or-bottom edge hit,
and let `R` be the inner Z values with a left-or-right edge hit. The interior
sample set is exactly `C x R`, visited in X-major order. The clean-room
scheduler behavior can be expressed as:

```text
sample TL, TR, BL, BR, in that order
if none hit: stop

for x in 1, 2:
    if TL or TR hit: sample (x, 0); add x to C if it hits
    if BL or BR hit: sample (x, 3); add x to C if it hits

for z in 1, 2:
    if TL or BL hit: sample (0, z); add z to R if it hits
    if TR or BR hit: sample (3, z); add z to R if it hits

for x in C, in increasing order:
    for z in R, in increasing order:
        sample (x, z)
```

`C` and `R` are sets here: two hits on opposite edges admit one coordinate,
not two interior calls.

For example, if only the top-left corner hits, top `(1,0)` hits, and left
`(0,2)` hits, the exact call order is:

```text
(0,0) (3,0) (0,3) (3,3)
(1,0) (2,0)
(0,1) (0,2)
(1,2)
```

The bottom and right gates stay closed. Only column 1 and row 2 are recorded,
so `(1,2)` is the only interior call. Corner hits themselves do not seed the
inner row or column sets.

## `hit` controls sampling; light controls darkness

Each sampled ray returns two independent results:

- `hit` controls whether that pixel is shaded and whether it opens later gates;
- `light` controls the amount of darkening after a hit.

For the 3D opacity map, a zero byte is ignored. Any nonzero opacity byte sets
`hit = true`. Byte 255 returns light 0 immediately. A partial byte keeps
`hit = true` and multiplies the remaining light. With opacity smoothing, its
effective opacity is also scaled by that ray segment's voxel travel length.

This distinction has two important effects:

- a partial foliage or water hit opens the same gates as an opaque hit;
- a zero-length partial segment can have `hit = true` and light 1, so it opens
  gates even though that sample causes no visible darkening.

Conversely, the caller does not use `light < 1` as a fallback hit test. When
`hit = false`, it skips the pixel adjustment and reports a miss to the gate
logic.

For a hit, the final lightness gain is:

```text
gain = (1 - shadowStrength) + shadowStrength * light
```

The public default shadow strength is 0.4, so light 0 gives gain 0.6.

## Synthetic probe check

The existing `/tmp/unmined-shadow-probe` creates a factor-4 caster, supplies a
synthetic shadow-map interface, and directly queries all 16 rays. It was rerun
without reading a world. The command required the local runtime with
`COMPlus_ReadyToRun=0` because the extracted application contains a ReadyToRun
image from a different runtime build.

An opaque block north of the receiver at world `(0,1,-1)` produced this full
ray-hit oracle:

```text
####
.###
.###
....
```

An opaque block northwest at `(-1,1,-1)` produced:

```text
##..
##..
##..
....
```

Replacing the north block with opacity byte 153 kept the same hit footprint,
but returned partial ray-light values:

```text
0.936603  0.636603  0.484259  0.484259
unhit     0.809808  0.657464  0.657464
unhit     0.983013  0.830669  0.830669
unhit     unhit     unhit     unhit
```

The shortcut reaches every hit in these three fixtures. That agreement does
not make the shortcut exhaustive: by construction, an interior-only footprint
with no corner hit is skipped.

## Acceptance-test recommendations

Test the sampling scheduler with a fake ray callback before combining it with
the DDA implementation. Record every requested coordinate and return explicit
`(hit, light)` pairs.

1. **Corner order and early stop.** Make all corners miss while an unsampled
   edge and interior coordinate would hit. Assert that the call list contains
   only `(0,0)`, `(3,0)`, `(0,3)`, `(3,3)` and that no output changes.
2. **Independent edge gates.** Make only the top-left corner hit. Assert calls
   to the two top and two left inner-edge samples, with no bottom or right
   calls. Make all four edge samples miss and assert that there are no interior
   calls.
3. **Row/column intersection.** With only top `(1,0)` and left `(0,2)` hitting,
   assert that `(1,2)` is the sole interior call. This catches rectangular
   fill, bounds-only fill, and X/Z transposition errors.
4. **Per-X edge order.** Open both top and bottom gates. Assert the sequence
   `(1,0)`, `(1,3)`, `(2,0)`, `(2,3)`. Then open both side gates and assert
   `(0,1)`, `(3,1)`, `(0,2)`, `(3,2)`.
5. **Hit versus light.** Return `hit = true, light = 1` for an edge. Assert that
   it admits its row or column but does not change RGB. Return
   `hit = false, light < 1` in a caller-contract test and assert that it neither
   shades nor admits an interior sample.
6. **Partial opacity.** Use opacity byte 153 with smoothing and assert both its
   partial light and `hit = true`. Verify final gain with the configured shadow
   strength and verify that it opens the same gates as byte 255.
7. **Known full-ray oracles.** Run both the exhaustive 16-ray sampler and the
   shortcut against the north, northwest, and foliage fixtures above. Assert
   the masks and light values, allowing only a small floating-point tolerance.
8. **Integrated receiver origin.** Through the prepared heightmap and
   `ApplyShade`, use receiver `TopY = 0`. Assert that all 16 fixed-point entries
   are 256, `blockY/subY` is `1/0`, and the first opacity lookup is Y 2. Assert
   no shadow for a north opaque voxel at Y 1, then assert
   `####/.###/.###/....` after moving only that voxel to Y 2. Repeat Y 2 with
   opacity byte 153 and assert the partial-light footprint. This catches both
   a missing receiver `+1` and an incorrect shift of stored opacity-run Ys.
9. **Documented approximation.** Add an interior-only or closed-edge fixture
   whose exhaustive sampler finds a hit but whose corners do not. Assert that
   the shortcut omits it. This prevents a future “correctness fix” from silently
   changing parity with the reference renderer.

A minimal injected-ray test needs only this hit set:

```text
{ (0,0), (1,0), (0,2), (1,2) }
```

Return `(hit=true, light=0.5)` at those coordinates and `(false, 1)` elsewhere.
The expected request list is:

```text
(0,0), (3,0), (0,3), (3,3),
(1,0), (2,0),
(0,1), (0,2),
(1,2)
```

The expected shaded coordinates are `(0,0)`, `(1,0)`, `(0,2)`, and `(1,2)`.
At shadow strength 0.4, each has gain 0.8. This one case verifies corner order,
closed bottom/right gates, edge order, `C x R`, and the lightness mix.

## Source evidence

The proprietary assemblies and decompiler output remain outside Git. The
findings above were traced from these local clean-room inspection points:

- `TerrainRendererState` constructor, lines 81-89: zoom factor;
- `TerrainRenderRequest.Prepare`, lines 80-101: factor-scaled pixel and
  heightmap allocation, including the height sentinel;
- `TerrainRendererChunkProcessorRequest.Prepare`, lines 297-301: the prepared
  pixel and height buffers passed into `TerrainRendererState`;
- `TerrainRendererState.RenderBlock`, lines 512-538, and `SetColor`, lines
  663-703: models-off `(TopY + 1) * 256` encoding and factor-4 replication;
- `TerrainRendererState.RenderBlockTextured`, lines 589-625: contrasting
  textured/model `TopY * 256 + 255` encoding;
- `TerrainRendererState.ApplyShade`, lines 389-465: optimized branch, corner
  order, edge gates, row/column bookkeeping, bounds, intersections, and
  exhaustive fallback;
- its local pixel routine, lines 473-506: fixed-point height decoding plus
  separate ray light and hit handling;
- `ShadowCaster`, lines 37-55 and 103-175: DDA precomputation from local Y
  `255/256`, opacity coordinates based on `blockY`, block-model-only use of
  `groundPoint`, opacity accumulation, and hit semantics;
- `ShadowRayCast`, lines 23-43 and 99-105: initial cell and first upward voxel
  crossing;
- `ShadowMapWithOpacity`, lines 59-89: opacity-byte lookup;
- `ShadowCasterPool`, lines 43-53: factor-matched caster creation;
- `/tmp/unmined-shadow-probe/Program.cs`, lines 24-69: synthetic factor-4 ray
  harness.

The integrated receiver-Y results were also checked with a transient reflection
harness against the same local assemblies. The harness and its build artifacts
were removed after the results above were recorded.

The broader clean-room context and the preserved probe matrices are in
[`unmined-renderer-internals.md`](./unmined-renderer-internals.md#deterministic-zoom-2-shadow-acceptance-cases).
