# Mapelix demo

A full-screen 2D map of a `mapelix-render` export, built on `@mapelix/viewer`. It works on phones
and desktops: drag with one finger or the mouse (a quick flick glides on), pinch or use the wheel
to zoom around the fingers or the pointer, double-tap or double-click to zoom in, and use the arrow
and +/− keys once the map has focus. The address bar keeps the view (`dimension`, `x`, `z`,
`scale` in CSS pixels per block).

```sh
pnpm exec turbo run build --filter=@mapelix/demo...
MAPELIX_TILES_DIRECTORY=/path/to/export node apps/mapelix-demo/build/index.js
```

`MAPELIX_TILES_DIRECTORY` is the folder given to `mapelix-render --output`. The server serves its
root `manifest.json` and immutable `generations/` below `/tiles`, and picks up each new
publication on the next page load. `HOST` and `PORT` choose the address (adapter-node defaults:
`0.0.0.0:3000`, so phones on the same network can open it).

For development, `pnpm --filter @mapelix/demo dev` serves on `127.0.0.1`, and `dev:lan` on every
network interface.

## Tests

```sh
pnpm --filter @mapelix/demo exec playwright test
```

The browser tests run the production build on a phone profile (375 × 812, touch, 3× pixels) and a
desktop profile. They render the shared fixture world once into `.local/demo-export`; set
`MAPELIX_E2E_TILES_DIRECTORY` to use another export. They cover drag and glide, pinch, double-tap,
wheel and keys, sharp enlarged tiles, center-first loading and cancelled requests, the layout of
the controls, and the first display time against Leaflet on the same export.
