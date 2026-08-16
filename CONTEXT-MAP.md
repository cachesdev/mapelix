# Context Map

## Mapelix

Mapelix converts Bedrock world records into visual map tiles.

- `packages/mapelix` owns Bedrock record decoding, subchunk decoding, surface selection, pixel rendering, PNG encoding, and Node file adapters.
- `apps/visual-check` is a disposable Playwright harness. It is not a viewer and is not part of the library interface.
- A future Canopy adapter can supply changed records without changing the renderer.

The module boundary is byte-oriented. Bedrock decoding must not depend on HTTP, Canopy, Leaflet, or a graphical user interface.

