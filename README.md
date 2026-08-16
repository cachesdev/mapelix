# Mapelix

> Prototype: prove that a pure TypeScript module can turn Minecraft Bedrock world data into useful map tiles.

The first milestone reads a Bedrock world, renders one standard 256 by 256 XYZ tile, and writes a PNG that Leaflet can request as `/tiles/{z}/{x}/{y}.png`.

This repository does not include a map viewer or a Canopy integration. Those are possible consumers of the tile API.

The prototype is proven against a real Bedrock world fixture. It reads LevelDB table and log data, decodes v9 palette subchunks and negative Y levels, finds the top visible block, applies colors and relief shading, and writes transparent PNG tiles. A Playwright test checks the generated terrain image in Chromium.

## Commands

Run commands from the repository root:

```sh
pnpm install
pnpm quality
pnpm test:e2e
```

The real-world tests use the system `unzip` command to expand the committed `.mcworld` fixture into a temporary directory.

See `packages/mapelix/README.md` for the module interface.
