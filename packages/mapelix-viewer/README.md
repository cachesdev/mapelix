# @mapelix/viewer

The Mapelix viewer and its server side.

| Entry                      | Runs in    | What it holds                                                                                |
| -------------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `@mapelix/viewer`          | browser    | `MapelixViewer`: the 2D tile map, the 3D world and the switch between them; the marker layer |
| `@mapelix/viewer/controls` | browser    | Optional DOM controls and the default marker editor, with host-given texts                   |
| `@mapelix/viewer/three`    | browser    | The 3D engine (`WorldViewer`) on its own                                                     |
| `@mapelix/viewer/node`     | Node.js 24 | The 3D scene server and request handlers for the tiles and the world                         |

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
