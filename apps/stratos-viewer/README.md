# Stratos Viewer

> Prototype app: browse a large local Bedrock world through Mapelix-generated tiles.

The default world is the temporary Linux-side copy at `/tmp/mapelix-stratos-tmbcraft-pruned-v2`. Override it when needed:

```sh
STRATOS_WORLD_DIRECTORY=/path/to/world \
STRATOS_RENDER_WORKERS=2 \
pnpm --filter @mapelix/stratos-viewer dev
```

The server renders visible PNG tiles on demand. It stores metadata and generated tiles under
`/tmp/mapelix-stratos-viewer-cache` by default. A warm restart can return cached tiles without
opening the world database. Set `STRATOS_CACHE_DIRECTORY` to change the cache location.

`STRATOS_RENDER_WORKERS` controls the number of tile worker threads. The default is two. Each
response includes `x-mapelix-cache: memory`, `disk`, or `render` and a `server-timing` duration so
the cache path is easy to measure. Leaflet magnifies or reduces the native z0 tiles for interactive
zooming.
