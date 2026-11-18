# Texture stacks

The 3D viewer can draw block textures near the camera. They come from Bedrock resource packs
that the host provides. The Mapelix packages never download a pack, and never ship or cache
pack textures outside the host's cache folder; only the demo app can download the vanilla pack,
when asked to.

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

## Changing the stack while the server runs

```ts
const report = await server.setTextures({ packs: ["/srv/packs/uploaded.mcpack"] });
if (!report.ok) console.warn(report.errors); // the previous stack is still served
await server.setTextures(null); // no textures
```

`setTextures(source)` takes `{ stack }` or `{ packs }` like the option, with the atlas options
and limits the server was created with. It reads the packs and builds the atlas first, so a
stack that cannot be read or built changes nothing: it comes back as a failed report, the same
one `validateTextureStack` gives. Otherwise it answers that report for the new stack and:

- the world metadata names the new revision; textured regions and atlases of the previous one
  answer 409 and 404, like a changed world;
- the previous atlas and textured regions leave the disk, even while a build of them finishes;
- a prewarm that already reached the textured regions starts them again for the new stack.

The same stack again builds nothing. Calls run one after another, and `null` removes the
textures. Events: `textures.changed` on a switch, `textures.rejected` for a refused stack. The
server keeps no record of the change: after a restart it uses its `textures` option again, so a
host that lets people choose a pack keeps their choice itself and passes it at start. Mapelix
has no upload route; the host checks who may change the pack and where packs come from. The demo
shows one way (`apps/mapelix-demo`, `MAPELIX_TEXTURE_UPLOADS`).

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
the pack.

### Images that break a limit

An image that cannot be used is skipped alone; the rest of its pack is used. That covers an
image over `maxImageSide`, `maxImagePixels` or `maxFileBytes` (a high-resolution animation strip,
for example 512 × 16,384 pixels), a damaged PNG or TGA, and an archive entry whose size, CRC or
compression method lies. The same image of the next pack takes its place, so a pack stacked
over the vanilla pack loses nothing; with no usable image left, the block keeps its color.

Each skipped image is listed with its pack, file and reason in the report's `skipped` (from
`setTextures`, `validateTextureStack` or `mapelix-textures`), and the server logs
`textures.images-skipped` when it builds the atlas. The limits are part of the revision, as
they decide which file each image comes from.

A whole pack is still refused for: a link, an unsafe or repeated entry name, an archive over
its size, entry or ratio limits, a missing or damaged manifest or block JSON file, and a pack
that changes while it is read.

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
  with one more word per quad (header byte 7 bit 0 set). A stale revision answers 409, like a stale
  world revision. Format 4 adds an optional block-light byte plane in both modes (bit 1),
  independently of the texture stream; see [block light](block-lighting.md).
- `regions/0/<x>/<z>?textures=<revision>&cutout=1`: the same region for detailed leaves, with
  the faces between neighbouring cut-out cubes such as leaves. `cutout=1` without `textures`
  answers 400. It is cached apart, under `cutout/` in the textured region cache.
- `regions/0/<x>/<z>?mode=caves&minY=…&maxY=…&textures=<revision>` (and `&cutout=1`): a
  textured level 0 cave slice. Like plain cave slices it is built on demand, even by a
  cache-only handler, and never prewarmed.

Textured regions have their own cache, `<cache>/textures/regions/`, bounded by
`textures.diskCacheMiB` (512 by default) and named after the world and texture revisions
together; `prewarm()` builds the atlas, then textured level 0 regions after the plain ones, and
reports them in `stats().prewarm.textures`. Textured cave slices have their own cache too,
`<cache>/textures/caves/`, with the sizes of the plain cave cache (`caveMemoryMiB`,
`caveDiskCacheMiB`, `caveMaxPending`), and `stats().texturedCaves`.

The atlas is built on its first request, or by a prewarm, and stored in
`<cache>/textures/atlas-v2/<revision>/`. Opening a server with another stack removes the older
revisions, as does opening one without a stack. A `createSceneHandler` with `cacheOnly` never
builds an atlas: it answers 404 `not-cached` until a prewarm stored it, and never builds a
textured region either.

## In the viewer

Textures are off by default; the host turns them on with the `textures` option or
`setTextures("on")`, and the settings panel has a "Block textures" switch. The viewer only learns
from `world.json` whether the server has textures (`textures.revision`); without them, or when
the atlas fails to load, `WorldStatus.textures` says `unavailable` or `failed` and the world keeps
its block colors.

- The atlas loads once from `textures/<revision>/atlas.bin` (about 630 KiB with Brotli for the
  vanilla pack) and takes its GPU size in `snapshot().textures.gpuBytes`.
- Level 0 Surface regions and cave slices whose nearest block draws at least
  `textureFade.none` CSS pixels are asked for again with `?textures=`. The plain region stays until its textured twin arrives,
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
- Leaves and other cubes with transparent texels draw `fast` by default: those texels take half
  the block's own color, the leaves' tint, so a canopy stays opaque, costs nothing more and
  looks like its plain color from afar. `leaves: "detailed"` (or `setLeaves("detailed")`, the
  "Detailed leaves" switch, `leaves=detailed` in the address) cuts them out and loads the
  `cutout=1` regions, which also draw the faces inside the foliage. In a dense forest these
  hold about 2.1 times the quads and bytes of fast regions; the frame rate did not change on
  an emulated phone, measured on a desktop GPU.
- Thin cut-out shapes, such as leaf litter, always cut out and never hide the face below them.
  Stained glass keeps its glass material.
- Blocks whose pack texture is a sheet of small parts read, face by face, their rectangle of the
  sheet as the vanilla pack lays it out: lantern bodies, caps and chains, torches, chains,
  candles, end rods with their base, lightning rods with their tip, and the floor of flower pots.
  Each model part names its rectangles (`ModelPart.sheet`); the quad's texture word carries the
  offset to them (bits 19 to 26), so a part costs no more than before. The sides of a rod read
  its column from the rod's positive end, whatever its axis. A pack that lays a sheet out
  differently shows other pieces of it.
- Beds are entities in the game: the atlas cuts six block tiles from each
  `textures/entity/bed/<color>.png` (64 by 64 texels, or a multiple): the mattress top of each
  half, its sides and its ends. A bed takes its color's tiles, the top turned so the pillow lies
  at the head; its wooden frame and legs keep their color.
- Turning textures off draws the same pixels as a server without textures, checked frame by
  frame in the browser tests.
- A changed stack shows without reloading the page. When the server answers 409 for a textured
  region, when the atlas fails to load, or when the page shows again, the viewer reads
  `world.json` again, at most every 5 seconds, and takes the new revision: the textured regions
  of the previous atlas leave at once and the plain ones show until the new ones arrive. A host
  that has just changed the stack can call `MapelixViewer.refreshWorld()` straight away.
- An atlas the server has not built yet answers 404: the viewer asks again after 0.5, 1, 2...
  seconds, at most 30 between tries, about a minute and a half in all, and checks `world.json` at
  each miss in case the stack changed. No page reload is needed.

## Checking a stack

`validateTextureStack(source, options)` from `@mapelix/viewer/node`, or the release's
`mapelix-textures` command, opens the stack, builds the atlas in memory and reports the
revision, each pack's fingerprint, the atlas sizes, the notices and the skipped images. It
writes nothing.

```bash
node mapelix-textures.js /srv/packs/world-1
node mapelix-textures.js --packs mine.mcpack vanilla.zip
node mapelix-textures.js --packs mine.mcpack vanilla.zip --max-tile-size 32 --budget-mib 64
```

`--packs` takes packs highest priority first, like the `packs` option. `--max-tile-size` and
`--budget-mib` are the atlas options of the server. In a checkout, the command is
`node packages/mapelix-viewer/dist/node/texture-cli.js` once the package is built. It exits 1
with `{ "ok": false, "errors": [...] }` when the stack cannot be used.

A high-resolution pack gets the tile size the atlas side and budget allow: with the defaults,
a full stack of about 2,000 textures fits at 16 pixels; a larger `budgetMiB` does not raise
it past the 2048-pixel atlas side.

To find the blocks a stack leaves with plain colors, build `@mapelix/scene-prototype` and run
its coverage script from that package. Without `--world` it checks every known block; with it,
it counts the blocks of a square of chunks around the spawn, or around `--center`, and lists the
ones not fully textured, most common first. It reads the world and never writes to it.

```bash
node scripts/texture-coverage.mjs vanilla.zip
node scripts/texture-coverage.mjs mine.mcpack vanilla.zip --world /srv/worlds/world-1 --radius 32
node scripts/texture-coverage.mjs vanilla.zip --world /srv/worlds/world-1 --dimension nether --center 0,0
```
