# Mapelix

Mapelix turns a Minecraft Bedrock world into a pre-rendered 2D map and a 3D world viewer, both in
TypeScript. The 3D view, isometric or perspective, opens from the map at the same place and scale
when you zoom in, and turns back into the map when you zoom out.

Mapelix is the bastard child of
[Mojang's Minecraft Creator Tools](https://github.com/Mojang/minecraft-creator-tools) and
[uNmINeD](https://unmined.net/). It takes Mojang's official tooling for reading worlds and combines
it with an almost-clean-room port reverse-engineered from a uNmINeD 0.20.1-dev binary, so the look of
uNmINeD maps becomes a low-level, programmatic TypeScript API with no native image or LevelDB
dependency and no call into the .NET uNmINeD CLI.

| 2D map                                                           | 3D view, perspective                                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ![A village and its river on the 2D map](docs/images/map-2d.jpg) | ![The same place in the 3D view, in perspective](docs/images/world-perspective.jpg) |

## Easiest start

For anyone who just wants to see their world, with no commands to learn:

1. Install [Node.js](https://nodejs.org) 24 or newer, and download this repository (green
   **Code** button, **Download ZIP**, then unzip it).
2. **Windows:** double-click `start.cmd`. **Linux and macOS:** run `./start.sh` in a terminal.
3. Give it your Bedrock world folder, the one that holds `db` and `level.dat`.

The first start installs and builds Mapelix, which takes a few minutes. Then, at every start, the
script copies the world, updates the 2D map (only what changed), starts the viewer with block
textures and block lighting, and opens the browser. It prints the address to open from a phone
on the same Wi-Fi. Keep the window open while you use the map; close it to stop.

- It remembers the world in `mapelix-start.json`. Start it with `--reconfigure` (or
  `--world <folder>`) to switch to another world. Each world keeps its own copy, map and caches
  in `mapelix-data/worlds/`, so switching never mixes two maps and coming back to a world reuses
  its map; texture packs are shared.
- The map starts with a single marker on the world spawn. Markers added with the editor are kept
  in the browser, one list per world.
- It can update the map while it runs: answer the question at the first start, or pass
  `--refresh <minutes>`. The viewer stops for a moment during each update.
- Other options: `--port <n>` (default 3000), `--data <folder>`, `--no-open`.
- It works on its own copy of the world and never writes to the world itself. For a world that
  is being played, the copy is most reliable while the game or the server is stopped.

## Quick start

Work on a copy of the world: Mapelix only reads it, but the game may change it while it runs.

Both renderers follow `db/CURRENT` and its LevelDB manifest. Unreferenced tables are ignored,
including unfinished files left by compaction. Invalid active files fail explicitly. See
[snapshot selection and integrity](docs/leveldb-snapshots.md).
After building, `node apps/render-cli/dist/index.js validate --world /path/to/world` checks
the complete selected snapshot without rendering or writing files, and prints a versioned JSON result.

1. **Install.** With [Mise](https://mise.jdx.dev/), which selects Node.js 24 and pnpm 11:

   ```sh
   mise install
   mise exec -- pnpm install
   mise exec -- pnpm exec turbo run build --filter=@mapelix/render-cli... --filter=@mapelix/demo...
   ```

2. **Render** the 2D map into an output folder:

   ```sh
   node apps/render-cli/dist/index.js --world /path/to/world --output /path/to/map \
     --dimension overworld,nether
   ```

3. **View** it. The demo is a full-screen map for phones and desktops. With
   `MAPELIX_WORLD_DIRECTORY`, zooming in past 5 CSS pixels per block turns the map into the 3D
   world at the same place and scale, and zooming out below 2 turns it back into the map:

   ```sh
   MAPELIX_TILES_DIRECTORY=/path/to/map \
   MAPELIX_WORLD_DIRECTORY=/path/to/world \
   PORT=3000 node apps/mapelix-demo/build/index.js
   ```

   Open `http://localhost:3000`, or the computer's address from a phone on the same network.
   Leave out `MAPELIX_WORLD_DIRECTORY` for the 2D map alone.

4. **Update** after the world changes: render again into the same folder with `--incremental`
   (only tiles whose chunks changed are drawn again) and `--surface-cache` (chunk surfaces are kept
   between runs, so redrawn tiles read less of the world). The open map picks up the new
   publication on the next page load.

   ```sh
   node apps/render-cli/dist/index.js --world /path/to/world --output /path/to/map \
     --dimension overworld,nether --incremental --surface-cache
   ```

5. **Textures** (optional): draw the 3D world with the textures of Bedrock resource packs. The
   simplest way is to let the demo download the vanilla pack and to choose packs on its
   `/textures` page:

   ```sh
   BODY_SIZE_LIMIT=256M MAPELIX_TEXTURE_UPLOADS=1 MAPELIX_TEXTURE_VANILLA=1 \
   MAPELIX_TILES_DIRECTORY=/path/to/map \
   MAPELIX_WORLD_DIRECTORY=/path/to/world \
   PORT=3000 node apps/mapelix-demo/build/index.js
   ```

   Then turn on **Block textures** in the settings panel; **Choose the texture packs** below that
   switch opens the packs page. See [Block textures](#block-textures) for the other ways.

## Features

### 2D map

- **Zooms −4..+2** by default: native tiles from 1 to 4 pixels per block, and transparent overview
  tiles down to 16 blocks per pixel, derived from native zoom zero
  ([overview contract](docs/2d-overviews.md)). Standard 256 × 256 XYZ PNG tiles.
- **Dimension profiles** for Overworld, Nether and End. The Nether is cut at Y 90 by default so
  its caverns show under the roof; `--top-y` sets another cut.
- **Classic look:** biome colors, elevation shading, water depth and transparency, contours and 3D
  shadows. Modern flat colors from a catalog shared with the 3D view are the default
  ([color catalog](docs/2d-block-colors.md)); `--appearance reference` keeps the previous palette,
  `--biome-blend-radius` smooths biome colors, `--shadows` changes or disables shadows.
- **Safe publication:** the CLI reads a snapshot, renders within worker, tile, byte, time and
  memory limits, and publishes a versioned JSON manifest atomically after a verified export.
- **Incremental updates:** `--incremental` redraws only tiles whose chunks, shadow halo or
  biome-blend window changed; `--surface-cache` keeps extracted chunk surfaces between runs.
- **Performance** on a small test world (Overworld, zooms −4..+2, 376 tiles, two workers): a full
  render takes about 15 s, an unchanged world 3.4 s, and an update after 20 changed chunks about
  7 s with the surface cache ([measurements](docs/2d-performance.md)).
- **Viewer:** one-finger or mouse drag with glide, pinch and wheel zoom around the fingers or the
  pointer, double-tap zoom, arrow and +/− keys, and the view kept in the address bar.

### 3D world

- **Streaming:** terrain near the camera is drawn block by block, simpler levels of detail stream
  out to the horizon. Drawn with three.js on WebGPU, with a WebGL 2 fallback.
- **Dimensions:** Overworld, Nether (with an adjustable ceiling cut) and End; changing dimension in
  3D reloads the world at the same place.
- **Caves:** 16 or 32-block slices, including enclosed negative-Y caverns, with automatic depth
  that follows the camera and a selectable exploration area
  ([underground rendering](docs/underground-rendering.md),
  [cave navigation](docs/cave-navigation.md)).
- **Discoveries:** ores (exposed or fully buried), spawners, containers, vaults, amethyst, sculk,
  portals and rails, with filters, a list, a detail card and a flight to each one, shown only
  when switched on ([discovery labels](docs/discovery-labels.md),
  [discovery navigation](docs/discovery-navigation.md)).
- **Sky:** clouds, rain, thunderstorm and time of day on the Overworld surface
  ([clouds and weather](docs/clouds-weather.md)).
- **Block light:** torches, lanterns, lava and other vanilla sources illuminate nearby blocks
  with or without textures, on the Surface and in Caves ([block light](docs/block-lighting.md)).
- **Projection:** isometric or perspective; the switch from the map starts isometric, looking
  straight down.
- **Controls:** one set of buttons for 2D and 3D that keep their place across the switch, sized for
  touch (48 px), light and dark, from `@mapelix/viewer/controls`. Touch: drag to move, two fingers
  to turn and tilt, pinch to zoom. Mouse: drag, right button to turn, wheel. Keys: WASD or arrows,
  Q/E, R/F, +/−, and Space/C up and down. Compass, return home, go to coordinates.

### Block textures

![The 3D view drawn with the textures of a resource pack](docs/images/texture_pack.jpg)

- **Bedrock resource packs** (folders, `.zip` or `.mcpack`) texture the 3D world near the camera:
  terrain, plants, leaves, water and lava animations, Surface and Caves. Far away, and below 4 CSS
  pixels per block, blocks keep their flat colors; between 4 and 8 pixels the two blend, so the
  textures fade in without a jump.
- **Stacks, as in the game:** packs are listed highest priority first, and a block takes each
  texture from the first pack that has it. A pack that changes a few blocks goes on top of the
  vanilla pack, which fills in the rest.
- **Any pack, safely:** packs are read with limits on size, entries, compression and image size.
  An image a pack holds but cannot be used, such as a 512-pixel animation strip or a damaged
  file, is skipped alone and taken from the next pack; the report names it.
- **Changed while running:** the scene server switches stacks without a restart
  (`SceneServer.setTextures`), and open maps pick up the new textures by themselves.
- **Light:** one atlas of every texture (about 6 MiB on the GPU and 630 KiB to download for the
  vanilla pack), textured regions only near the camera, and the untextured view unchanged pixel
  for pixel. **Detailed leaves** cut out leaf holes, at about twice the geometry in forests.
- Mapelix never ships or downloads a pack itself; the host gives the packs. The demo can
  download Mojang's vanilla pack (Bedrock samples on GitHub) when asked to.

Three ways to give packs:

| Where                 | How                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Demo page `/textures` | `MAPELIX_TEXTURE_UPLOADS=1`: add a pack on top, add the vanilla pack at the bottom, reorder, remove, see skipped images. The choice survives restarts. |
| Demo, fixed at start  | `MAPELIX_TEXTURE_PACKS="mine.mcpack:vanilla.zip"` (highest priority first, `;` on Windows) or `MAPELIX_TEXTURE_STACK=/path/to/stack-folder`.           |
| Your own server       | `createSceneServer({ textures: { packs: [...] } })` or `{ stack }`, then `setTextures()` to change it ([texture stacks](docs/texture-stack.md)).       |

Check a stack without a server, from the command line. It prints the texture revision, each
pack's fingerprint, the atlas size, the packs and files used, and the skipped images, and writes
nothing:

```sh
mise exec -- pnpm exec turbo run build --filter=@mapelix/viewer...
node packages/mapelix-viewer/dist/node/texture-cli.js --packs mine.mcpack vanilla.zip
node packages/mapelix-viewer/dist/node/texture-cli.js /path/to/stack-folder
node packages/mapelix-viewer/dist/node/texture-cli.js --packs mine.mcpack vanilla.zip \
  --max-tile-size 32 --budget-mib 64
```

The demo's packs page has the same API from a terminal (`curl` examples in the
[demo README](apps/mapelix-demo/README.md#texture-packs)):

```sh
curl http://localhost:3000/demo/textures
curl -X POST -H "x-mapelix-demo: 1" -H "x-mapelix-pack-name: mine.mcpack" \
  --data-binary @mine.mcpack http://localhost:3000/demo/textures
```

Lanterns, torches, chains, candles, end rods, lightning rods and flower pots read their pieces
from their texture's sheet of parts, as the vanilla pack lays it out. Beds take their colored
entity texture. Not textured yet: signs, mobs and other entities, and the 2D map.

### Dynamic block lighting

![Lanterns lighting a village at night in the 3D view](docs/images/dynamic-block-lighting-2.jpg)

> **New:** shader-based night lighting with glowing blocks, light propagation, and support for
> both textured and non-textured rendering.

### Markers

- **Host markers** on the map and in 3D (isometric and perspective) at the same place:
  `viewer.markers.set / upsert / update / remove / clear`, with an icon (a few characters or an
  http(s) image), a color, a label, a group to show or hide, a priority and free host data.
  Mapelix stores nothing; a tap or a click reports `onClick` with the marker.
- **Readable on phones:** labels go where they overlap no marker, label or control, and markers
  closer than about 48 px group into a count bubble that zooms in when tapped. A drag that starts
  on a marker still moves the view.
- **Light:** only the markers and groups in view exist in the page; 1,000 markers cost about 1 ms
  per frame on a phone-class CPU.
- **Default editor** in `@mapelix/viewer/controls`: add with a button then a tap, or a long press
  on the map or the 3D view; tap a marker for its card (edit, delete after confirming); drag the
  marker being edited. The host turns editing on or off, decides rights per marker, adds its own
  form fields, validates, and saves in `onCreate` / `onUpdate` / `onDelete`: a refusal shows its
  message. Texts come from the host; on phones the form is a bottom sheet that stays above the
  keyboard.

### Gallery

| Isometric                                                                 | Thunderstorm at dusk                                                                    |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ![The 3D view in isometric projection](docs/images/world-isometric.jpg)   | ![Rain and a darker sky over the same hill](docs/images/world-thunderstorm.jpg)         |
| **Caves**                                                                 | **Discoveries**                                                                         |
| ![A cave slice under the same place](docs/images/world-caves.jpg)         | ![Ore and other discovery markers in the cave slice](docs/images/world-discoveries.jpg) |
| **Nether**                                                                | **Village, golden hour**                                                                |
| ![The Nether under an adjusted ceiling cut](docs/images/world-nether.jpg) | ![A village at golden hour in the 3D view](apps/prototype-viewer-3d/docs/village.jpg)   |

## Packages and apps

| Path                                                                             | Role                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/mapelix-core`](packages/mapelix-core/README.md)                       | 2D dimension profiles, the shared block-color catalog and the batch export API (`@mapelix/core/node/batch`) used by the CLI.                                                                                                                                    |
| [`packages/mapelix-prototype`](packages/mapelix-prototype/README.md)             | Reference 2D renderer: reads Bedrock LevelDB worlds and renders uNmINeD-style tiles. Holds the visual regression suite.                                                                                                                                         |
| [`packages/mapelix-scene-prototype`](packages/mapelix-scene-prototype/README.md) | Builds 3D scene regions from a world in worker threads: meshes, levels of detail, cave slices, discoveries.                                                                                                                                                     |
| [`packages/mapelix-viewer`](packages/mapelix-viewer/README.md)                   | Browser viewer: the 2D tile map, `MapelixViewer` (one API for the map, the 3D view and the switch between them), the marker layer, the optional DOM controls (`./controls`) and the 3D engine (`./three`); the 3D scene server and request handlers (`./node`). |
| [`apps/render-cli`](apps/render-cli/README.md)                                   | `mapelix-render`: exports and updates the 2D tiles and their manifest.                                                                                                                                                                                          |
| [`apps/mapelix-demo`](apps/mapelix-demo/README.md)                               | Full-screen SvelteKit host for phones and desktops: serves an export and, optionally, the 3D world.                                                                                                                                                             |
| [`apps/prototype-viewer`](apps/prototype-viewer/README.md)                       | Leaflet map that renders tiles on demand from the world, with no render step: handy to look at a world once, slower to browse.                                                                                                                                  |
| [`apps/prototype-viewer-3d`](apps/prototype-viewer-3d/README.md)                 | Full 3D explorer with its developer panel (F3) and the automatic-perspective demo.                                                                                                                                                                              |
| `apps/prototype-visual-check`                                                    | Browser smoke test that renders the committed fixture world with the reference renderer.                                                                                                                                                                        |

All packages are private and their APIs can still change.

## Known limits

- **Bedrock only**, read from a folder. Updates are not live: render again (with `--incremental`)
  after the world changes. The 2D renderer runs in Node.js, not in the browser.
- **The 3D view needs a server** that reads the world; there is no static 3D export.
- **2D:** no textures and no isometric images. Bed colors stored in block entities are not read yet.
- **3D:** coarse levels of detail can close narrow caves; the Nether atmosphere does not change with
  biomes; custom dimensions and entities are not drawn, and unknown blocks fall back to a plain
  solid. Block textures show near the camera only, and a few small models keep their colors (see
  [Block textures](#block-textures)).
- **Isometric 3D:** exploration-area handles still pick as in perspective, and discovery markers
  behind the camera can show.
- **Discoveries** are limited by a search budget around the view, and exposure is uncertain next to
  unsaved chunks.
- Two 3D browser tests sometimes time out in a full run while terrain loads, and pass alone.

## Similarity to uNmINeD

The committed visual suite compares renders of the reference renderer (`@mapelix/prototype`) with
lossless uNmINeD reference renders across ten scenes from a real world. It checks structure, block
color, shadows and tile alignment. The production default uses the modern color catalog;
`--appearance reference` selects the measured look.

| Signal                     |               Baseline |
| -------------------------- | ---------------------: |
| Overall similarity         |             **97.12%** |
| Exact structural-edge F1   |                 94.52% |
| One-pixel-tolerant edge F1 |                 97.07% |
| Shadow-mask F1             |                 97.47% |
| Block-color similarity     |                 99.37% |
| Native-tile alignment      | Exact in all 10 scenes |

| Mapelix                                                                                                                       | uNmINeD                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| ![A village rendered by Mapelix](packages/mapelix-prototype/test/visual-regression/scenes/village-roofs/mapelix-baseline.png) | ![The same village rendered by uNmINeD](packages/mapelix-prototype/test/visual-regression/scenes/village-roofs/unmined.png) |

Run it with `mise exec -- pnpm test:visual`. See the
[visual regression suite](packages/mapelix-prototype/test/visual-regression/README.md) for the
input format and the reports, and [`REWRITE.md`](REWRITE.md) for the per-scene scores.

## Development

```sh
mise install
mise exec -- pnpm install
mise exec -- pnpm quality
mise exec -- pnpm test:visual
```

If Mise asks you to trust the project configuration, review `mise.toml` and run `mise trust`. If
Mise is already activated in your shell, you can omit `mise exec --`. The real-world tests use the
system `unzip` command to expand the committed `.mcworld` fixture into a temporary directory.

## Documentation

- 2D: [CLI options and manifest](apps/render-cli/README.md),
  [overviews](docs/2d-overviews.md), [colors](docs/2d-block-colors.md),
  [performance](docs/2d-performance.md).
- 3D: [3D explorer](apps/prototype-viewer-3d/README.md),
  [dimensions](docs/native-dimensions.md), [underground rendering](docs/underground-rendering.md),
  [underground exploration](docs/underground-exploration.md),
  [cave navigation](docs/cave-navigation.md), [clouds and weather](docs/clouds-weather.md),
  [block models and lava](docs/block-models-and-lava.md), [block colors](docs/block-colors.md),
  [block textures and resource packs](docs/texture-stack.md).
- Discoveries: [labels](docs/discovery-labels.md), [navigation](docs/discovery-navigation.md).
- Hosting: [scene server and handlers](packages/mapelix-viewer/README.md),
  [snapshot selection and integrity](docs/leveldb-snapshots.md),
  [demo](apps/mapelix-demo/README.md), [on-demand viewer](apps/prototype-viewer/README.md).
- Background: [`OPTIMIZATIONS.md`](OPTIMIZATIONS.md) (speed, memory and accuracy experiments),
  [`REWRITE.md`](REWRITE.md) (production rewrite ledger and open questions),
  [`docs/research`](docs/research) (clean-room notes on map rendering and uNmINeD behavior).
