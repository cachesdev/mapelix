# Texture stacks

The 3D viewer can draw block textures near the camera. They come from Bedrock resource packs
that the host provides. Mapelix never downloads a pack, and never ships or caches pack
textures outside the host's cache folder.

## Giving packs to the scene server

```ts
createSceneServer({
  worldDirectory,
  cacheDirectory,
  textures: { stack: "/srv/packs/world-1" }, // a stack folder, described below
  // or: textures: { packs: ["/srv/packs/mine.mcpack", "/srv/packs/vanilla.zip"] },
});
```

| Option        | Default   | Meaning                                                          |
| ------------- | --------- | ---------------------------------------------------------------- |
| `stack`       |           | A read-only folder holding the packs and `mapelix-stack.json`.   |
| `packs`       |           | Pack folders, `.zip` or `.mcpack` files, highest priority first. |
| `maxTileSize` | 32        | Largest tile side, a power of two from 4 to 256.                 |
| `budgetMiB`   | 32        | GPU memory the atlas may take with its mipmaps.                  |
| `limits`      | see below | Bounds on reading the packs.                                     |

The server reads no environment variable. A stack that cannot be read is logged
(`textures.failed`), shown in `stats().textures.error`, and the world is served untextured.

## The stack folder

The host prepares the folder and keeps it read-only while the server runs. It holds the packs,
each as an extracted folder, a `.zip` or a `.mcpack` file, and one `mapelix-stack.json`:

```json
{
  "format": "mapelix-texture-stack",
  "version": 1,
  "packs": [
    {
      "path": "world/my_pack",
      "uuid": "6c9d8e1a-0000-4000-8000-000000000001",
      "version": "1.2.0",
      "fingerprint": "0123456789abcdef0123"
    },
    { "path": "vanilla", "uuid": "0575c61f-a5da-4b7f-9961-ffda2908861e", "version": "1.21.0" }
  ]
}
```

Rules:

- `format` is `"mapelix-texture-stack"` and `version` is `1`. A Mapelix that reads another
  version refuses the file.
- `packs` lists 1 to 32 packs, **highest priority first**, as Bedrock stacks them. A texture,
  terrain entry, block entry or flipbook missing from a pack is taken from the next one.
- `path` is relative to the stack folder, with `/` separators. It may not be absolute, hold
  `..`, `.`, an empty segment or a backslash, or go through a link. It names a folder, a `.zip`
  or a `.mcpack` file. The same path may not appear twice.
- `uuid` and `version` must equal the `header.uuid` and `header.version` of the pack's
  `manifest.json` (version written dotted, `[1, 2, 0]` as `"1.2.0"`). A mismatch refuses the
  stack.
- `fingerprint` is optional. When present it must equal the pack's fingerprint as
  `mapelix-textures` reports it; the stack is refused otherwise. It pins the exact content.
- Unknown keys are ignored.

Inside a pack, `manifest.json` with a `resources` module sits at the root or in a single
top-level folder. Mapelix reads `blocks.json`, `textures/terrain_texture.json`,
`textures/flipbook_textures.json` and the PNG or TGA images they name. Nothing else is read.

## Safety limits

Every pack is opened without following links: a link anywhere in a pack folder, or a pack that
is itself a link, refuses the stack. Archives are read entry by entry, never whole.

| Limit                                       | Default         |
| ------------------------------------------- | --------------- |
| `maxArchiveBytes` (one `.zip` or `.mcpack`) | 1 GiB           |
| `maxEntries` (files in one pack)            | 65,536          |
| `maxTotalBytes` (uncompressed, one pack)    | 2 GiB           |
| `maxFileBytes` (one file read)              | 16 MiB          |
| `maxCompressionRatio` (above 1 MiB)         | 400 to 1        |
| `maxImagePixels` / `maxImageSide`           | 4 Mi / 8192     |
| `maxPacks`                                  | 32              |
| `maxStackEntries` / `maxStackBytes`         | 262,144 / 4 GiB |

Zip entries must be stored or deflated, unencrypted, without ZIP64, with names that stay in
the pack. A size, CRC or compression method that lies refuses the file when it is read.

Memory stays bounded: one decoded image at a time, plus the atlas (about 6 MiB for the vanilla
pack at 16-pixel tiles). The atlas side never exceeds 2048 pixels, the size every WebGL 2
device must sample; a high-resolution pack gets smaller tiles until it fits.

## Revision, cache and routes

`getWorldMetadata().textures` gives `{ revision, packs }`. The texture revision changes with
any pack's content, the pack order, `maxTileSize` or `budgetMiB`. It is separate from the world
revision.

- `textures/<revision>/atlas.bin`: the atlas, Brotli or gzip encoded when the client accepts
  it, immutable.
- `textures/<revision>/notices.json`: the packs and image files the atlas was made of, for
  attribution on a public map, immutable.

- `regions/0/<x>/<z>?textures=<revision>`: a textured level 0 Surface region, the region format
  with one more word per quad (header byte 7 set). A stale revision answers 409, like a stale
  world revision. Plain regions, without `textures`, are unchanged byte for byte.

Textured regions have their own cache, `<cache>/textures/regions/`, bounded by
`textures.diskCacheMiB` (512 by default) and named after the world and texture revisions
together; `prewarm()` builds the atlas, then textured level 0 regions after the plain ones, and
reports them in `stats().prewarm.textures`.

The atlas is built on its first request, or by a prewarm, and stored in
`<cache>/textures/atlas-v2/<revision>/`. Opening a server with another stack removes the older
revisions. A `createSceneHandler` with `cacheOnly` never builds an atlas: it answers 404
`not-cached` until a prewarm stored it, and never builds a textured region either. Changing
the stack takes a server restart.

## In the viewer

Textures are off by default; the host turns them on with the `textures` option or
`setTextures("on")`, and the settings panel has a "Block textures" switch. The viewer only learns
from `world.json` whether the server has textures (`textures.revision`); without them, or when
the atlas fails to load, `WorldStatus.textures` says `unavailable` or `failed` and the world keeps
its block colors.

- The atlas loads once from `textures/<revision>/atlas.bin` (about 630 KiB with Brotli for the
  vanilla pack) and takes its GPU size in `snapshot().textures.gpuBytes`.
- Level 0 Surface regions whose nearest block draws at least `textureFade.none` CSS pixels are
  asked for again with `?textures=`. The plain region stays until its textured twin arrives,
  then they dissolve into each other; at most 160 textured regions stay cached beyond those on
  screen.
- Each pixel blends from the block color to the texture between `textureFade.none` and
  `textureFade.full` pixels per block (4 and 8 by default), measured from the projection itself,
  so perspective, isometric and the transition between them fade at the same block size. The map
  turns 2D below 2 pixels per block, under the fade.
- Textures are sampled at the fraction of the block coordinate with gradients from the
  continuous coordinate, inside the tile's gutter, so neither filtering nor mipmaps reach a
  neighbor tile at any distance. Animated tiles (water, lava, fire) step through their frames.
- Terrain and plants are textured; lava, water and glass keep their own materials. Tinted
  textures take the biome color. An `overlay_color` texture, like the grass block side, uses its
  alpha as the mask of the pixels that take the block color; terrain stays opaque elsewhere, and
  plant sprites cut out along the texture's alpha once it shows.

## Checking a stack

`validateTextureStack(source, options)` from `@mapelix/viewer/node`, or the release's
`mapelix-textures` command, opens the stack, builds the atlas in memory and reports the
revision, each pack's fingerprint, the atlas sizes and the notices. It writes nothing.

```bash
node mapelix-textures.js /srv/packs/world-1
```

It exits 1 with `{ "ok": false, "errors": [...] }` when the stack cannot be used.
