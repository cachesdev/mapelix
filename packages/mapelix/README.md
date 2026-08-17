# `@mapelix/core`

This package is the Mapelix prototype module. It is pure TypeScript and has no native image or LevelDB dependency.

The Node interface is small:

```ts
import { openBedrockWorld, writeLeafletTile } from "@mapelix/core";

const world = await openBedrockWorld({
  directory: "/srv/amelix/world",
  renderConcurrency: 2,
});
const tile = await world.renderTile({ dimension: "overworld", z: 0, x: 0, y: 0 });
await writeLeafletTile(tile, { root: "generated-tiles" });
```

This writes `generated-tiles/0/0/0.png`. A Leaflet grid layer can request the output with `/tiles/{z}/{x}/{y}.png`.

At prototype zoom 0, tile `(x, y)` covers 256 by 256 blocks. Tile `y` follows Minecraft Z. Missing chunks are transparent. Other zoom levels are rejected.

For a future live source, `createBedrockWorld(effectiveRecords)` bypasses file access and accepts Bedrock key/value records directly. This is the intended Canopy seam.

## Prototype boundaries

- Reads Bedrock LevelDB `.ldb`, `.sst`, and `.log` files, including tombstones and sequence ordering.
- Decodes persistent palette subchunks v8 and v9. Other subchunk versions fail with a clear error.
- Uses the primary block storage layer. It does not render waterlogging overlays, entities, structures, or texture packs.
- Reads legacy Data2D biome IDs used by the Stratos world. Modern Data3D biome palettes are not implemented yet.
- Uses biome-aware grass, foliage, and water colors. A seam-safe five-block blend softens biome boundaries without hiding their shape.
- Uses water-depth compositing, a sea-level-relative elevation gradient, four-neighbor hill shading, and bounded cast shadows. Foliage transmits part of the shadow light. Callers can inject a `BlockStyleResolver`.
- Does not validate LevelDB checksums yet.
- Builds the index one database file at a time. It retains packed subchunk keys and only the 256/512-byte biome payload from Data2D records. Block values load on demand. More workers increase throughput and temporary memory use.
- Does not interpret `CURRENT` or `MANIFEST` yet. Point it at a clean world snapshot without orphaned LevelDB files.
