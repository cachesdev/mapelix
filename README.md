# Mapelix

> Prototype: prove that a pure TypeScript module can turn Minecraft Bedrock world data into useful map tiles.

The first milestone reads a Bedrock world, renders one standard 256 by 256 XYZ tile, and writes a PNG that Leaflet can request as `/tiles/{z}/{x}/{y}.png`.

This repository does not include a map viewer or a Canopy integration. Those are possible consumers of the tile API.

## Commands

Run commands from the repository root:

```sh
pnpm install
pnpm quality
pnpm test:e2e
```

See `packages/mapelix/README.md` for the module interface.

