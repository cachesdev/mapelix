# `@mapelix/core`

This package is the Mapelix prototype module.

The intended interface is small:

```ts
const world = await openBedrockWorld({ directory: "/srv/amelix/world" });
const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
await writeLeafletTile(tile, { root: "generated-tiles" });
```

At prototype zoom 0, tile `(x, y)` covers 256 by 256 blocks. Tile `y` follows Minecraft Z. Missing chunks are transparent. Other zoom levels are not yet supported.
