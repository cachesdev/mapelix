# @mapelix/viewer

The Mapelix viewer and its server side.

| Entry                      | Runs in    | What it holds                                                                                |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `@mapelix/viewer`          | browser    | `MapelixViewer`: the 2D tile map, the 3D world and the switch between them; the marker layer |
| `@mapelix/viewer/controls` | browser    | Optional DOM controls and the default marker editor, with host-given texts                   |
| `@mapelix/viewer/three`    | browser    | The 3D engine (`WorldViewer`) on its own                                                     |
| `@mapelix/viewer/node`     | Node.js 24 | The 3D scene server and request handlers for the tiles and the world                         |

## Browser bundle

`pnpm run build:embed` writes `dist-embed/mapelix-viewer.js`, one ES module with three.js
included, for hosts without a build step, and `dist-embed/mapelix-viewer.css`. The module holds
everything the browser entries above export, plus `EMBED_API_VERSION` and `isViewerSupported()`
(WebGPU or WebGL 2). It has no inline code, eval or workers, so it runs under
`script-src 'self'`.

```js
const mapelix = await import("/assets/mapelix-viewer.js");
if (mapelix.EMBED_API_VERSION !== 4 || !mapelix.isViewerSupported()) showFallback();
const viewer = new mapelix.MapelixViewer(element, {
  tiles: await mapelix.TileIndex.load("/tiles/manifest.json"),
  world: { base: "/world/" },
});
```

The viewer adds its styles to the page. Where the content policy forbids inline styles, link the
stylesheet first; the viewer then adds none:

```html
<link rel="stylesheet" href="/assets/mapelix-viewer.css" data-mapelix-styles />
```

### API version 4 (changes from 3)

Version 3 was a 3D-only bundle, `mapelix-viewer-3d.js`. Version 4 is `mapelix-viewer.js`:

- The main class is `MapelixViewer`: the 2D tile map, the 3D world and the switch between them,
  with markers and the optional `createViewerControls`. `WorldViewer` is still exported, with
  the same options, for a host that shows the 3D view alone.
- With `MapelixViewer`, the world is given as `world.base`, the URL prefix of `world.json`,
  `regions/` and `discoveries/`. Other 3D options, such as `regionSuffix` and `discoverySuffix`,
  go in `world.options`.
- `CAVE_LIMITS`, `DEFAULT_DISCOVERY_FILTERS`, `DISCOVERY_CATEGORIES`, `DISCOVERY_KINDS`,
  `DISCOVERY_LIMITS`, `SELECTION_LIMITS`, `selectionAround` and `isViewerSupported` keep their
  names and meaning.
- Styles come from the bundle, or from `mapelix-viewer.css` linked with `data-mapelix-styles`.

## Serving the 3D world (`@mapelix/viewer/node`)

`createSceneServer` reads a Bedrock world folder (never writes it) and builds the 3D scene
regions and discovery indexes the viewer asks for. It listens on nothing: the host routes
requests, with `createSceneHandler` or its own routes.

```ts
import { createSceneHandler, createSceneServer, createTileHandler } from "@mapelix/viewer/node";

const scene = createSceneServer({
  worldDirectory: "/srv/world", // level.dat and db/
  cacheDirectory: "/var/cache/mapelix",
  workers: 2,
  onEvent: (event, detail) => console.log(event, detail),
});
await scene.ready(); // rejects with MissingWorldError when the folder holds no world
void scene.prewarm(); // optional: build the Surface regions and discoveries ahead

const world = createSceneHandler(scene, "/world");
const tiles = createTileHandler("/srv/map", "/tiles");
// In any server that speaks Request/Response:
const response = (await world(request)) ?? (await tiles(request)) ?? notFound();
```

### Options

| Option                                                               | Default      | Meaning                                                                                                      |
| -------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `workers`                                                            | 1            | Builds that may run at once, across every dimension                                                          |
| `dimensions`                                                         | all          | Dimensions served (`overworld`, `nether`, `the-end`)                                                         |
| `poolIdleSeconds`                                                    | 300          | A dimension's builder threads close after this idle time, or 5 s after another dimension opens; 0 keeps them |
| `bounds`                                                             | stored area  | Serve only this block rectangle (`minX`, `minZ`, `maxX`, `maxZ`) in every dimension                          |
| `memoryMiB`, `diskCacheMiB`, `maxPending`                            | 64, 1024, 32 | Surface regions: memory, disk quota, distinct builds waiting                                                 |
| `caveMemoryMiB`, `caveDiskCacheMiB`, `caveMaxPending`                | 16, 128, 8   | The same for cave slices                                                                                     |
| `discoveryMemoryMiB`, `discoveryDiskCacheMiB`, `discoveryMaxPending` | 4, 64, 8     | The same for discovery indexes                                                                               |
| `onEvent`                                                            | none         | Cache, pool, prewarm and build events, for the host's log                                                    |

### Behavior

- **Revision.** The world revision hashes the engine code that builds regions, the database file
  names, sizes and times and `level.dat`, without reading the tables and without the folder path:
  a new snapshot or a new engine gets a new revision, a moved snapshot keeps its cache. Clients
  add it to region URLs, so responses can be cached forever.
- **Caches.** Memory, then disk (one folder per revision, each with its byte quota; the oldest
  files go first). Other revisions are removed when the server opens.
- **Shared, bounded builds.** Callers asking for the same region share one build; a build every
  caller abandoned stops before it starts. Past `maxPending` distinct builds, a request fails
  with `OverloadedError` (the handler answers 503 with `retry-after`).
- **Stored area.** The area of each dimension comes from one scan of the database keys, saved per
  revision, or from `bounds`. A region or discovery index outside it is answered with an empty
  payload, without a build or a disk write.
- **Dimensions.** One build budget serves every dimension; idle dimensions close their threads.
  Background work (the prewarm) waits behind every visitor.
- **Prewarm.** `prewarm({ maxRegions, discoveries })` builds the Surface regions of the stored area,
  coarse levels and the middle first, then every discovery index; it stops before a disk cache
  is full. A second call returns the first run.
- **Stats.** `stats()` gives the revision, open dimensions, builds, caches and prewarm progress;
  the host chooses whether and where to show them.

### Handlers

`createSceneHandler(server, base, options)` serves `world.json`, `regions/<level>/<x>/<z>` and
`discoveries/<x>/<z>.bin` below `base`, with the scene context in the query string. Bad requests
answer 400, a stale `revision` 409, a cancelled request 499, too many builds 503 and a missing world 503. Out-of-world responses carry `x-mapelix-cache: empty`.

For a public or anonymous front end, `{ cacheOnly: true }` serves Surface regions from the cache
only (404 `not-cached` until the prewarm built them); with `maxBuilds: n`, cave slices and
discovery indexes may still be built, at most `n` at once through that handler (503 beyond).
Authentication, rate limits and routes stay with the host.

`createTileHandler(directory, base)` serves a `mapelix-render` output folder: the root
`manifest.json` uncached and the immutable `generations/<sha256>/…` files, refusing any path that
leaves the folder.
