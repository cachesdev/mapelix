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

Tiles are always 256 by 256 pixels. Native zooms 0 through 3 render blocks at 1×1, 2×2, 4×4, and 8×8 pixels, so each higher zoom covers half as many blocks per axis. Tile `y` follows Minecraft Z. Missing chunks are transparent.

For a future live source, `createBedrockWorld(effectiveRecords)` bypasses file access and accepts Bedrock key/value records directly. This is the intended Canopy seam.

## Prototype boundaries

- Reads Bedrock LevelDB `.ldb`, `.sst`, and `.log` files, including tombstones and sequence ordering.
- Decodes persistent palette subchunks v8 and v9. Other subchunk versions fail with a clear error.
- Uses the primary block storage layer. It does not render waterlogging overlays, entities, structures, or texture packs.
- Reads legacy Data2D biome IDs used by the Stratos world. Modern Data3D biome palettes are not implemented yet.
- Uses biome-aware grass, foliage, and water colors. Biome tint is discrete by default to match uNmINeD; callers can request an artistic seam-safe transition with `biomeBlendRadius`.
- Uses water-depth compositing, the uNmINeD Bedrock elevation color and lightness curves, a selective one-pixel contour on shared height edges, and native output-subpixel 3D-opacity shadows. The default shadow pass uses the published 120-degree sun direction, 45-degree altitude, 40% strength, and ray-chord-smoothed water and foliage opacity. Equal-height interiors stay flat. Paths and common artificial roof materials use distinct style colors instead of generic terrain colors. Callers can disable shadows or inject a `BlockStyleResolver`.
- Treats grass, flowers, ferns, and saplings as decorative cover supported by the ground below, so they do not create false terrain relief. The untextured renderer keeps a flat same-material region uniform; it does not use generated grain or resource-pack textures.
- Does not validate LevelDB checksums yet.
- Builds the index one database file at a time. It retains packed subchunk keys and only the 256/512-byte biome payload from Data2D records. Block values load on demand. More workers increase throughput and temporary memory use.
- Does not interpret `CURRENT` or `MANIFEST` yet. Point it at a clean world snapshot without orphaned LevelDB files.
