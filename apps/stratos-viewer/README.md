# Mapelix Viewer

> Prototype app: browse a large local Bedrock world through Mapelix-generated tiles.

The local prototype defaults to the copied current Amelix SMP world at
`.local/worlds/Amelix-8-12-26/Amelix SMP` from the monorepo root. Override it
when needed:

```sh
MAPELIX_WORLD_DIRECTORY=/path/to/world \
MAPELIX_RENDER_WORKERS=2 \
pnpm --filter @mapelix/stratos-viewer dev
```

The server renders visible PNG tiles on demand. It stores metadata and generated tiles under
`/tmp/mapelix-amelix-viewer-cache` by default. A warm restart can return cached tiles without
opening the world database. Set `MAPELIX_CACHE_DIRECTORY` to change the cache location.

`MAPELIX_RENDER_WORKERS` controls the number of tile worker threads. The default is two. Each
response includes `x-mapelix-cache: memory`, `disk`, or `render` and a `server-timing` duration so
the cache path is easy to measure. Leaflet requests native z0 through z3 tiles. Those levels render
each block at 1×1 through 8×8 pixels. Zoom 4 enlarges the z3 result.

The Playwright acceptance test still selects the older copied Stratos world
explicitly. This keeps the existing visual golden stable while Amelix is the
default manual comparison world. The old `STRATOS_*` environment names remain
as compatibility aliases.
