# Mapelix demo

A full-screen 2D map of a `mapelix-render` export, built on `@mapelix/viewer`. It works on phones
and desktops: drag with one finger or the mouse (a quick flick glides on), pinch or use the wheel
to zoom around the fingers or the pointer, double-tap or double-click to zoom in, and use the arrow
and +/− keys once the map has focus. The address bar keeps the view (`dimension`, `x`, `z`,
`scale` in CSS pixels per block).

```sh
pnpm exec turbo run build --filter=@mapelix/demo...
MAPELIX_TILES_DIRECTORY=/path/to/export node apps/mapelix-demo/build/index.js
```

`MAPELIX_TILES_DIRECTORY` is the folder given to `mapelix-render --output`. The server serves its
root `manifest.json` and immutable `generations/` below `/tiles`, and picks up each new
publication on the next page load. `HOST` and `PORT` choose the address (adapter-node defaults:
`0.0.0.0:3000`, so phones on the same network can open it).

With `MAPELIX_WORLD_DIRECTORY` set to a Bedrock world folder (only read, never written), the
server also serves the 3D world below `/world`. Zooming in past 5 CSS pixels per block then turns
the map into the 3D world, isometric and looking straight down, at the same center and scale;
zooming out below 2 turns the camera back north and down and shows the map again. The controls come from
`@mapelix/viewer/controls` and only call the `MapelixViewer` API, with texts from the demo
(`src/lib/texts.ts`):

- bottom right: isometric or perspective (3D), 3D/2D, zoom; bottom left: settings, home (world
  spawn), dimension; bottom center in caves: descend, ascend, recover the camera;
- top: coordinates (the block under the mouse, else the view center), scale and status; compass in
  3D (tap to face north);
- settings panel: Surface or Caves (slice thickness and depth, automatic depth, exploration area),
  Nether ceiling, clouds, rain, thunderstorm and time of day (Overworld surface), discoveries
  (filters, list; a tap flies there and opens its card), go to coordinates.

On phones the panel and the discovery card take the free space between the top row and the
buttons; they close with ×, Escape, a swipe down on the panel header or a tap on the map. Keys go to
the map or the 3D view after any tap on a button: arrows and +/− on the map; WASD, arrows, Q/E,
R/F, +/− and Space/C up and down in 3D. Clouds, weather and automatic depth are kept on the
device; the address keeps the view and the other settings. `MAPELIX_CACHE_DIRECTORY`
chooses where 3D regions are cached (default: the system temporary folder).

For development, `pnpm --filter @mapelix/demo dev` serves on `127.0.0.1`, and `dev:lan` on every
network interface.

## Markers

The demo shows example markers around the world spawn (`src/lib/sample-markers.ts`): a few places
with icons, colors and labels, one with an image, one in the Nether, and a survey of 40 points that
group when zoomed out. They go through `viewer.markers`, as a host's own data would; a tap selects a
marker and shows its label first, a tap on a group zooms in on it.

Markers can be added, edited and deleted (`src/lib/marker-store.ts`): the demo keeps them in this
browser's local storage only, adds a "Public" field, and leaves the spawn read-only.
`?readonly=1` shows the map as a public, read-only page.

## Texture packs

The 3D world can draw blocks with the textures of Bedrock resource packs near the camera. They
are off until **Textures** is turned on in the settings panel. Engine details:
[`docs/texture-stack.md`](../../docs/texture-stack.md).

### How a stack works

Packs form a stack, highest priority first. A block takes each texture from the first pack that
has it; the packs below fill in what it lacks. So a pack that changes only a few blocks goes on
top of the vanilla pack, which keeps every other block textured. An image the server cannot use
(too large, such as a 512-pixel animation strip, or damaged) is skipped alone and taken from
the next pack; the rest of its pack is used.

### Packs fixed at start

```sh
MAPELIX_TEXTURE_PACKS="/packs/mine.mcpack:/packs/vanilla.zip" \
MAPELIX_WORLD_DIRECTORY=/path/to/world MAPELIX_TILES_DIRECTORY=/path/to/export \
node apps/mapelix-demo/build/index.js
```

`MAPELIX_TEXTURE_PACKS` lists packs separated by the path delimiter (`:`, or `;` on Windows),
highest priority first. `MAPELIX_TEXTURE_STACK` names a stack folder with its
`mapelix-stack.json` instead. Either one wins over the stack chosen on the page.

### Choosing packs on a page

```sh
BODY_SIZE_LIMIT=256M MAPELIX_TEXTURE_UPLOADS=1 MAPELIX_TEXTURE_VANILLA=1 \
MAPELIX_WORLD_DIRECTORY=/path/to/world MAPELIX_TILES_DIRECTORY=/path/to/export \
node apps/mapelix-demo/build/index.js
```

For development: `MAPELIX_TEXTURE_UPLOADS=1 ... pnpm --filter @mapelix/demo dev:lan` (no body
limit there).

With `MAPELIX_TEXTURE_UPLOADS=1`, the settings panel links to the page `/textures`, which shows
the stack and changes it while the server runs:

- **Add this pack**: uploads a `.zip` or `.mcpack`; it goes on top and wins.
- **Add the vanilla pack**: downloads it the first time, then puts it at the bottom.
- **↑ ↓**: move a pack; **✕**: take it out of the stack; **Remove every pack**: no textures.
- **Skipped images**: each image the server could not use, with its pack and the reason.
- **← Back to the map**: returns to the map at the view it had. Changes apply at once; there
  is nothing to save.

Open maps pick up each change by themselves. A stack the server cannot use is refused and the
current one stays. The stack is kept in `current.json` and used again after a restart.

| Variable                         | Default                    | Meaning                                         |
| -------------------------------- | -------------------------- | ----------------------------------------------- |
| `MAPELIX_TEXTURE_UPLOADS`        | off                        | `1` enables `/textures` and its API.            |
| `MAPELIX_TEXTURE_VANILLA`        | off                        | `1` adds the vanilla pack at start if no stack. |
| `MAPELIX_TEXTURE_PACK_DIRECTORY` | `<cache>/texture-packs`    | Where uploaded and downloaded packs are kept.   |
| `MAPELIX_TEXTURE_PACK_MIB`       | 256                        | Largest pack, uploaded or downloaded.           |
| `MAPELIX_VANILLA_PACK_URL`       | Bedrock samples v1.26.60.5 | Where the vanilla pack comes from (~162 MiB).   |
| `BODY_SIZE_LIMIT`                | 512K (built server)        | Set it to `256M` to upload packs.               |

The vanilla pack is the resource pack of Mojang's Bedrock samples, downloaded from GitHub.

### The same from a terminal

The page uses this API at `/demo/textures`; changes need the `x-mapelix-demo: 1` header.

```sh
# The stack, the served revision and the skipped images
curl http://localhost:3000/demo/textures
# Add a pack on top
curl -X POST -H "x-mapelix-demo: 1" -H "x-mapelix-pack-name: mine.mcpack" \
  --data-binary @mine.mcpack http://localhost:3000/demo/textures
# Add the vanilla pack at the bottom
curl -X POST -H "x-mapelix-demo: 1" "http://localhost:3000/demo/textures?source=vanilla"
# Reorder or drop packs: the files listed by GET, highest priority first
curl -X PUT -H "x-mapelix-demo: 1" -H "content-type: application/json" \
  -d '{"packs":["upload-<id>.zip","vanilla-<id>.zip"]}' http://localhost:3000/demo/textures
# Remove every pack
curl -X DELETE -H "x-mapelix-demo: 1" http://localhost:3000/demo/textures
```

Changes answer the server's report: 200 when used, 422 when refused (`errors` says why), 413
for a pack over the size limit.

### Checking a pack without the demo

```sh
pnpm exec turbo run build --filter=@mapelix/viewer...
node packages/mapelix-viewer/dist/node/texture-cli.js --packs mine.mcpack vanilla.zip
```

It prints the report the page would get (revision, packs, atlas size, skipped images) and
writes nothing.

This page is for the demo only. It has no access control beyond a header that other sites
cannot send, so do not enable it on a public server.

## Tests

```sh
pnpm --filter @mapelix/demo exec playwright test
```

The browser tests run the production build on a phone profile (375 × 812, touch, 3× pixels) and a
desktop profile. They render the shared fixture world once into `.local/demo-export` and start a second server with that world for the 3D switch; set
`MAPELIX_E2E_TILES_DIRECTORY` to use another export. They cover drag and glide, pinch, double-tap,
wheel and keys, sharp enlarged tiles, the switch to 3D and back at the same center and scale, center-first loading and cancelled requests, the layout of
the controls, and the first display time against Leaflet on the same export.

`tests/layout.e2e.ts` checks that no control overlaps another, the coordinates, an open panel or
the discovery card, in 2D and 3D, panels open and closed, on phones (portrait and landscape),
tablets and desktops, in light and dark. Set `MAPELIX_CAPTURES` to a folder to keep a screenshot of
each layout.

`tests/markers.e2e.ts` checks that a marker shows at the same place on the map and in 3D
(isometric and perspective), that a tap selects it and a drag starting on it moves the view, that
labels never overlap and markers group when zoomed out, that labels stay text and images only load
from http(s) or relative addresses, and that 1,000 markers keep panning and zooming smooth (phone
profile with a 4× slower CPU).

`tests/marker-editor.e2e.ts` adds, edits and deletes markers (button and tap, long press in 2D and
3D), checks that a drag or a pinch never adds one, that the edited marker follows a drag, that the
host's refusals and rights show, that a read-only map offers no editing, that the form stays in view
above a phone keyboard, and that no panel or card covers a control.
