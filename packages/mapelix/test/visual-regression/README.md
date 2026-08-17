# Renderer visual regression suite

This directory preserves the lossless uNmINeD oracle and the final Mapelix
prototype baseline for seven Amelix scenes. It is test input, not generated
documentation.

Each scene owns five files:

- `unmined.png` and `unmined-shadowless.png`: lossless reference renders;
- `mapelix-baseline.png` and `mapelix-baseline-shadowless.png`: the current
  prototype output;
- `mapelix-baseline-surface.json`: block, biome, height, visible-layer, and
  shadow-run data used to attach XYZ and material names to errors.

Run the committed baseline through all CV checks:

```sh
pnpm --filter @mapelix/core test:visual
```

Render and test a new implementation against the same oracle:

```sh
MAPELIX_VISUAL_WORLD=/path/to/Amelix\ SMP \
MAPELIX_VISUAL_OUTPUT=/tmp/mapelix-visual-regression \
pnpm --filter @mapelix/core test:visual
```

The runner scans the world once, writes candidates outside the worktree by
default, and produces edge overlays, color heatmaps, shadow overlays, per-scene
reports, and a summary. A pre-rendered candidate directory can be supplied with
`MAPELIX_VISUAL_CANDIDATES`; each scene uses `<id>.png`,
`<id>-shadowless.png`, and `<id>-surface.json`.

The Amelix world and reconstructed LevelDB manifest are intentionally not in
Git. They are large private inputs. The oracle PNGs were rendered from the
user-provided Amelix backup with uNmINeD 0.20.1-dev using zoom 2, 3D-opacity
shadows, no block models, and background `#78a7ff`. No uNmINeD binary or
decompiled source is included.

Thresholds are conservative gates below the committed prototype baseline.
They prevent a rewrite from silently losing structure, material color, shadow
shape, or raster alignment. The complete numeric reports remain the stronger
signal when a deliberate style change needs a new baseline.
