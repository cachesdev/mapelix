# Context Map

## Mapelix

Mapelix is the monorepo for the production renderer and its completed reference prototype.
Production rewrite work starts from the acceptance baseline and ledger in `REWRITE.md`.

- `packages/mapelix-prototype` owns the archived Bedrock decoder, surface selection, renderer, PNG encoding, and Node file adapters.
- `packages/mapelix-prototype/test/visual-regression` owns the lossless uNmINeD oracle, final prototype baseline, scene thresholds, and XYZ-aware computer-vision acceptance suite. Large worlds and third-party tools stay under ignored `.local/` storage.
- `apps/prototype-visual-check` is a disposable Playwright harness. It is not a viewer and is not part of the library interface.
- `apps/prototype-viewer` is a disposable SvelteKit and Leaflet consumer. It owns the persistent PNG cache and selects the prototype render-worker count.
- Production packages and apps must use new directories and the `@mapelix/core` package name.
- A future Canopy adapter can supply changed records without changing the renderer.

The module boundary is byte-oriented. Bedrock decoding must not depend on HTTP, Canopy, Leaflet, or a graphical user interface.
