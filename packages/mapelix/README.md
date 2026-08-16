# `@mapelix/core`

This package is the Mapelix prototype module. It is pure TypeScript and has no native image or LevelDB dependency.

The Node interface is small:

```ts
import { openBedrockWorld, writeLeafletTile } from "@mapelix/core";

const world = await openBedrockWorld({ directory: "/srv/amelix/world" });
const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
await writeLeafletTile(tile, { root: "generated-tiles" });
```

This writes `generated-tiles/0/0/0.png`. A Leaflet grid layer can request the output with `/tiles/{z}/{x}/{y}.png`.

At prototype zoom 0, tile `(x, y)` covers 256 by 256 blocks. Tile `y` follows Minecraft Z. Missing chunks are transparent. Other zoom levels are rejected.

For a future live source, `createBedrockWorld(effectiveRecords)` bypasses file access and accepts Bedrock key/value records directly. This is the intended Canopy seam.

## Prototype boundaries

- Reads Bedrock LevelDB `.ldb`, `.sst`, and `.log` files, including tombstones and sequence ordering.
- Decodes persistent palette subchunks v8 and v9. Other subchunk versions fail with a clear error.
- Uses the primary block storage layer. It does not render waterlogging overlays, biomes, entities, structures, or texture packs.
- Uses a compact built-in color resolver with relief shading. Callers can inject a `BlockStyleResolver`.
- Does not validate LevelDB checksums yet.
- Loads all matching table and log files into memory before tile filtering. Large Stratos-scale worlds need a streaming record source in the next pass.
- Does not interpret `CURRENT` or `MANIFEST` yet. Point it at a clean world snapshot without orphaned LevelDB files.
