# 2D export performance

This page records how long a classic 2D export takes today, where the time goes, and the proposed
follow-up. All numbers come from one small local Bedrock snapshot (Overworld and Nether, no stored End
chunks) on a desktop Ryzen 7 7800X3D with Node 24.14.1. The OS file cache was not controlled. Treat
them as relative observations, not release budgets.

## Baseline before batch 4b

Fresh process and output, compiled CLI, two rendering workers, default output (opacity shadows):

| Dimension | Zooms   | Tiles | Elapsed  | Peak RSS   | Overview composition |
| --------- | ------- | ----: | -------: | ---------: | -------------------: |
| Overworld | 0       |    17 |  15.59 s | 1019.5 MiB |                    — |
| Overworld | -4..0   |    36 |  16.18 s | 1007.9 MiB |             0.290 s |
| Overworld | -4..+2  |   376 | 151.32 s | 1018.1 MiB |             0.297 s |
| Nether    | 0       |     8 |   4.18 s |  758.5 MiB |                    — |
| Nether    | -4..0   |    24 |   4.44 s |  756.4 MiB |             0.179 s |
| Nether    | -4..+2  |   184 |  34.43 s |  772.8 MiB |             0.159 s |

The same Overworld export with shadows disabled takes 25.29 s (376 tiles, 717.9 MiB peak RSS).
Shadows therefore account for about 126 s of the 151 s.

## Reference renderer on the same snapshot

The reference renderer was run on a fresh copy of the same snapshot, one chunk processor, zooms
-4..+2, PNG output:

| Dimension | Shadows               | Elapsed  | PNGs |
| --------- | --------------------- | -------: | ---: |
| Overworld | `2d` (height shading) | 10.82 s  |  607 |
| Overworld | `3do` (opacity)       | 12.89 s  |  607 |
| Nether    | `2d`, top Y 90        |  7.36 s  |  352 |
| Nether    | `3do`, top Y 90       |  6.44 s  |  352 |

With matched opacity shadows, Mapelix is about 12 times slower on the Overworld. The reference
renderer also writes some fully empty native tiles (28 at zoom 0 against 17), so tile counts differ
while the 19 overview tiles match.

## Where the time went before batch 4b

A dense diagnostic profile (timers in every worker, about 50 % overhead, so not a baseline) shows:

- **Native zooms are rendered independently.** Zoom 0, +1 and +2 each read the world again. Every
  tile builds a fresh decoded record set; there is no cache across tiles or zooms.
- **The shadow halo dominates.** A tile requests a 256-block north/west halo plus one border block.
  The input grid is 513, 385 and 321 columns wide at zoom 0, +1 and +2, about 4, 9 and 25 times the
  visible core area. Halo surface extraction takes about 24, 71 and 223 cumulative worker-seconds at
  zoom 0, +1 and +2, against about 9 s per zoom for the visible core. The halo is about 65 % of the
  cumulative worker time.
- **The same data is decoded many times.** The Overworld has 15,794 distinct stored subchunks but
  the export performs 617,915 subchunk decodes, about 39 per subchunk (60,919 / 143,967 / 413,029 by
  zoom). The Nether shows about 31 decodes per subchunk.
- **Other stages are small.** Cumulative LevelDB parsing is 3.4 / 9.8 / 31.6 s, subchunk decoding
  2.4 / 5.1 / 15.0 s, the direct shadow pass 1.6 / 4.5 / 5.4 s and PNG encoding 0.1 / 0.4 / 1.3 s.

Profiling hooks were observational: every profiled export produced PNGs byte-identical to the
unprofiled exports.

## Shared caches and spatial scheduling (batch 4b)

The native zooms now reuse work across tiles, with unchanged output:

1. **Chunk surfaces.** Each renderer keeps the extracted surface of every chunk it decodes: top
   block, cover, water depth, colour layers, biome ID and the full-height opacity runs used by
   shadows. A surface depends only on the chunk's records, the dimension's surface range and the
   surface style, so neighbouring tiles and zooms 0, +1 and +2 reuse it. The 256-block shadow halo
   is still read and shaded at full resolution; it is just no longer re-extracted for every tile.
   Entries are keyed by dimension, surface range, surface style and whether the chunk's biome
   records are in the tile's biome neighbourhood.
2. **Database records.** Map records of a database file are parsed and inflated once per renderer
   and kept by file name, instead of rereading the file for every tile. A file larger than the
   record budget is still read per tile for the requested keys only.
3. **Spatial scheduling.** Batch exports sort native tiles by zoom-0 area (north to south, west to
   east), then by zoom, and give each concurrent lane a contiguous band. The worker pool sends a job
   to the idle worker whose previous tile was nearest. A lane that finishes early takes work from
   the end of the largest remaining band.

Both caches are least-recently-used and bounded by `renderCacheMiB` per renderer (default 256:
a quarter for records, the rest for surfaces). Sizes are estimates of retained memory. `0` disables
reuse. Surfaces used by a tile are pinned for that render, so eviction never changes a tile.

Same snapshot and machine, fresh process and output, two workers, default output:

| Dimension | Zooms  | Tiles | Before   | After (3 runs)    | Peak RSS before / after |
| --------- | ------ | ----: | -------: | ----------------: | ----------------------: |
| Overworld | -4..+2 |   376 | 151.44 s | 14.43–14.62 s     | 1026 / 1110–1171 MiB    |
| Nether    | -4..+2 |   184 |  34.30 s | 5.15–5.43 s       |  823 / 848–915 MiB      |
| Overworld, shadows off | -4..+2 | 376 | 25.29 s | 7.80 s |  718 / 942 MiB          |

The Overworld export with default opacity shadows is now within twice the reference renderer's
height-shading time (10.82 s), and close to its opacity-shadow time (12.89 s). Every PNG of these
exports, including the overview zooms, is byte-identical to the previous exports. The OS file
cache was warm (the snapshot is 15 MiB); cold-cache runs were not controlled separately.

No shadow quality was changed: there is no reduced halo, no resizing between native zooms and no
lighter shadow mode.

## Incremental updates (batch 5)

`incremental: true` (CLI `--incremental`) updates the published export from a new snapshot and
reuses every tile whose inputs did not change. The output is byte-identical to a full render of the
new snapshot: the generation ID, and so the manifest and every PNG, are the same.

- **Change detection.** Every generation stores `source-chunks.json`, listed in the manifest as
  `sourceChunks`. It holds a 128-bit fingerprint per chunk of the effective map records (subchunks,
  Data2D, Data3D) after LevelDB sequence and tombstone resolution. Changed, deleted and new chunks
  are the keys whose fingerprints differ.
- **Exact dependencies.** A native tile depends on every chunk intersecting its surface input
  (including the 256-block north/west shadow halo and the one-block east/south border) and its
  biome-blend window (`tileDependencyBounds`). Each changed chunk marks exactly the tiles whose
  dependency bounds it intersects, at every native zoom. An overview tile is redone when one of its
  zoom-0 tiles is affected, including one that appears or disappears.
- **Reuse.** Unaffected tiles are copied from the published generation after their SHA-256 is
  checked. New tiles are rendered, tiles that lost their coverage are dropped, and hidden zoom-0
  overview sources are always rendered. The new generation is verified as before.
- **Fallback.** A full render runs, with a reason in the result, when there is no published
  generation, or its renderer revision, appearance resources, grid or render settings differ, or
  its chunk index is missing or does not match its digest.

The batch result reports `update` (mode, reason, changed chunks, rendered, composed and reused
tiles); it is not stored in the manifest.

Local measurements, Overworld and Nether -4..+2. Updated snapshots are copies of the local snapshot
with one appended LevelDB log that rewrites whole chunks, deletes some and adds one. Every update
was compared with a full render of the same snapshot: same generation, zero differing tiles.

| Update                                   | Changed chunks | Rendered + composed / reused | 2 workers | 1 worker |
| ---------------------------------------- | -------------: | ---------------------------: | --------: | -------: |
| Unchanged Overworld                      |              0 |                    0 / 376 |    3.4 s |   3.5 s |
| Unchanged Nether                         |              0 |                    0 / 184 |    2.0 s |   2.0 s |
| 20 neighbouring chunks, 2 deleted, 1 new |             23 |                 117 / 280 |   11.9 s |  15.0 s |
| 400 neighbouring chunks, 10 deleted, 1 new |          411 |                 171 / 226 |   12.0 s |  17.4 s |
| 170 scattered chunks, 5 deleted, 1 new   |            176 |                 319 / 78 |   14.6 s |  22.1 s |
| Full render of an updated Overworld      |              — |                   397 / 0 |   15.2 s |       — |

An unchanged dimension costs indexing, fingerprinting and copying (about 0.4 s of indexing here,
the rest is file copies and verification). An update costs much less than its share of tiles
suggests, because each rendered tile still extracts its whole 256-block shadow halo, mostly from
unchanged chunks that no longer get reused by neighbouring rendered tiles. Scattered changes reach
most tiles through the halo. The persistent surface cache below removes that extraction cost.

For scale: the reference renderer, with height shading and no halo, redrew 4,805 changed Overworld
chunks of a larger world and kept 672 unchanged tiles in 57 s on one core, and checked an unchanged
Nether in 4 s.

## Persistent chunk surface cache (batch 5b)

With `surfaceCache` (`--surface-cache[=<mib>]`), extracted chunk surfaces outlive the export, so
a re-rendered tile reads the surfaces of its unchanged halo chunks instead of decoding them again.

- **Layout.** `<output>/.mapelix-surface-cache/<namespace>/<config>/<x>_<z>.pack`, one pack per
  256 x 256 block storage tile. The namespace digests the renderer revision, appearance resources,
  appearance and biome-blend radius; the config digests the dimension, surface range (cut) and
  surface style. Each entry stores the chunk fingerprint it was extracted from (the fingerprint of
  batch 5) and is only used while it is unchanged. A biome-free variant is derived from the
  biome-scoped one, so most chunks are stored once.
- **Verification.** Packs carry a format version, their dimension and config digest, and a SHA-256
  trailer; entries are decoded with shape checks. A missing, truncated, corrupt or foreign pack or
  entry is ignored and the surface is extracted again, so the cache cannot change pixels. Surfaces
  holding values the encoding cannot reproduce exactly are not stored.
- **Writes and cleanup.** Renderers only read packs; new surfaces are sent to the coordinating
  process, which rewrites affected packs once, on a clean close (an aborted export writes nothing),
  with a temporary file and a rename. The same pass drops entries whose chunk changed or
  disappeared, removes damaged packs, unknown files and other namespaces, then evicts packs not
  rewritten in this export first, then rewritten ones, until the store fits its bound (512 MiB
  by default; about 2.5 KB per chunk here).
- **Ownership.** The directory is created below the owned output root; every existing component is
  rejected if it is a symbolic link or junction before the export, and again before each pack is
  read, written or removed.

Same updates as batch 5 (Overworld, from a cached full export of the same base snapshot), 2 / 1
workers. Every update produced the same generation with and without the cache, and every tile
matched the batch-5 full renders of the updated snapshots.

| Update                                     | Rendered + composed / reused | Extracted chunks | No cache | Cache, 2 workers | Cache, 1 worker |
| ------------------------------------------ | ---------------------------: | ---------------: | -------: | ---------------: | --------------: |
| Unchanged                                  |                    0 / 376 |                0 |    3.4 s |            3.4 s |           3.5 s |
| 20 neighbouring chunks, 2 deleted, 1 new   |                  117 / 280 |               41 |   11.8 s |            6.9 s |          10.2 s |
| 400 neighbouring chunks, 10 deleted, 1 new |                  171 / 226 |              653 |   12.1 s |            9.4 s |          14.7 s |
| 170 scattered chunks, 5 deleted, 1 new     |                   319 / 78 |              290 |   14.7 s |           11.7 s |          19.6 s |
| Full render, empty cache                   |                    376 / 0 |            3,152 |   14.5 s |           15.4 s |               — |
| Full render, warm cache                    |                    376 / 0 |                0 |        — |            9.5 s |               — |

Extraction is now proportional to the changed chunks (both workers extract each changed chunk
once, in both variants when needed). What remains is the fixed cost of an unchanged export and the
shading of every dirty tile: one changed chunk still dirties every tile whose 256-block shadow halo
covers it (up to about 4 zoom-0, 12 zoom-1 and 30 zoom-2 tiles). Writing the cache adds about 1 s to
a full render with an empty cache. A damaged cache (flipped bytes, a truncated and a deleted pack,
junk files) gave the same tiles; the three damaged packs were rejected and replaced.

### Fixed cost of an update

Every export, even an unchanged one, hashes every database file (source identity), indexes every
map record and digests every record value (chunk fingerprints). On Linux (ext4, Node 24.14.1,
14.7 MiB database, 2,444 chunks), measured three times after dropping the page cache and again
warm:

| Startup step                               | Cold   | Warm   |
| ------------------------------------------ | -----: | -----: |
| Source identity (SHA-256 of all files)     | 0.18 s | 0.16 s |
| Open and index                             | 0.49 s | 0.48 s |
| Open, index and chunk fingerprints         | 0.61 s | 0.59 s |

At this size disk reads are negligible; the cost is parsing, inflating and hashing, linear in the
database size. A world ten times larger (about 150 MiB) should take about 1.8 s for the source
identity and 6 s to index and fingerprint, plus about 0.3 s of cold reads on an SSD (1.5 s at
100 MB/s). An unchanged Overworld export takes 2.5 s on Linux and 3.4 s on Windows; beyond startup,
most of it copies and verifies the 376 reused tiles, which grows with the tile count rather than the
database size.

Possible follow-ups, not planned yet:

- **Per-file record digests.** LevelDB table files are immutable, so their indexed keys and value
  digests could be cached by file name and size; startup would then only read new files.
- **No copies of reused tiles.** A generation could reference unchanged tiles of the previous one
  (or hard-link them) instead of copying and re-verifying them; this changes the generation layout
  and its retention rules.
