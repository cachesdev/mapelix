# Stratos Viewer

> Prototype app: browse a large local Bedrock world through Mapelix-generated tiles.

The default world is the temporary Linux-side copy at `/tmp/mapelix-stratos-tmbcraft-pruned-v2`. Override it when needed:

```sh
STRATOS_WORLD_DIRECTORY=/path/to/world pnpm --filter @mapelix/stratos-viewer dev
```

The server opens the world once, indexes its z0 tile coverage, and renders visible PNG tiles on demand. Leaflet magnifies or reduces those native tiles for interactive zooming.
