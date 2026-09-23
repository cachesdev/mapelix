# Context Map

## Mapelix

Mapelix is the monorepo for the production renderer and its completed reference prototype.
Production rewrite work starts from the acceptance baseline and ledger in `REWRITE.md`.

- `packages/mapelix-prototype` owns the archived Bedrock decoder, surface selection, renderer, PNG encoding, and Node file adapters.
- `packages/mapelix-prototype/test/visual-regression` owns the lossless uNmINeD oracle, final prototype baseline, scene thresholds, and XYZ-aware computer-vision acceptance suite. Large worlds and third-party tools stay under ignored `.local/` storage.
- `apps/prototype-visual-check` is a disposable Playwright harness. It is not a viewer and is not part of the library interface.
- `apps/prototype-viewer` is a disposable SvelteKit and Leaflet consumer. It owns the persistent PNG cache and selects the prototype render-worker count.
- `packages/mapelix-scene-prototype` is the second prototype. It owns the seekable LevelDB reader, block appearance, voxel and column meshing, and the binary scene region format. Its `./format` entry has no Node.js dependency. It reuses the Bedrock decoders from `@mapelix/prototype/bedrock`.
- `apps/prototype-viewer-3d` is a disposable SvelteKit and three.js consumer of the scene prototype. It owns the persistent region cache, the region worker count, streaming, and all rendering.
- Production packages and apps must use new directories and the `@mapelix/core` package name.
- A future Canopy adapter can supply changed records without changing the renderer.

The module boundary is byte-oriented. Bedrock decoding must not depend on HTTP, Canopy, Leaflet, or a graphical user interface.
