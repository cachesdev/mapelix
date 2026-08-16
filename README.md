# Mapelix

> Prototype: prove that a pure TypeScript module can turn Minecraft Bedrock world data into useful map tiles.

The first milestone reads a Bedrock world, renders standard 256 by 256 XYZ tiles, and writes PNGs that Leaflet can request as `/tiles/{z}/{x}/{y}.png`.

The repository also includes a disposable SvelteKit viewer for the copied Stratos world. It proves that the module can support a real interactive Leaflet map. A Canopy integration remains future work.

The prototype is proven against a real Bedrock world fixture. It reads LevelDB table and log data, decodes v9 palette subchunks and negative Y levels, finds the top visible block, applies colors and relief shading, and writes transparent PNG tiles. A Playwright test checks the generated terrain image in Chromium.

## Commands

Run commands from the repository root:

```sh
pnpm install
pnpm quality
pnpm test:e2e
```

The real-world tests use the system `unzip` command to expand the committed `.mcworld` fixture into a temporary directory.

To run the Stratos viewer with another copied Bedrock world:

```sh
STRATOS_WORLD_DIRECTORY=/path/to/world pnpm --filter @mapelix/stratos-viewer dev
```

The server builds a block-subchunk-only index. It does not retain chest inventories, block entities, actors, or other unrelated LevelDB values.

See `packages/mapelix/README.md` for the module interface.
