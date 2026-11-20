# `@mapelix/render-cli`

Generic, bounded classic 2D export from an extracted Bedrock snapshot. Requires Node.js 24 or later.
The reusable implementation is [`@mapelix/core/node/batch`](../../packages/mapelix-core/README.md#batch-export).
It has no HTTP server, authentication, application routes or service-manager integration.

Build from the repository root, then run the compiled entry:

```sh
pnpm exec turbo run build --filter=@mapelix/render-cli
node apps/render-cli/dist/index.js --help
node apps/render-cli/dist/index.js \
  --world /srv/snapshots/world --output /srv/maps/export \
  --dimension overworld,nether,end --zooms=-4,-3,-2,-1,0,1,2 \
  --workers 2 --max-pending 2 --max-tiles 10000 \
  --timeout-seconds 300 --memory-budget-mib 2048
```

The output's parent must already exist. Use a stable, read-only snapshot, never an actively written
database. The command does not create a snapshot or require a running Minecraft server. Output is
confined to the explicitly named directory, which must be disjoint from the input in both directions.
An empty selected dimension succeeds with no tiles. Stored chunks expand only into their own native
tiles and overview ancestors, so distant explored areas do not fill the rectangle between them.

All dimensions use their core profiles: Overworld Y-64..319, Nether Y0..127 with included `topY=90`,
and End Y0..255. `--top-y` overrides the included cut in every selected dimension and must be valid
for each one. For a negative cut, use `--top-y=-64`. `end` aliases the canonical `the-end` path.

Modern flat colors are the default. `--appearance reference` retains the previous palette while
keeping dimension profiles. `--shadows opacity` uses the renderer's existing opacity shadows;
`--shadows off` disables them. Textures and isometric image output are outside this command.

`--biome-blend-radius <n>` averages biome-dependent colors (grass, foliage, water) over the
surrounding `n` blocks, from 0 to 16. The default 0 keeps the reference renderer's per-block biome
colors; a radius widens each tile's input window by `n` blocks, so incremental updates re-render
tiles within that distance of a changed chunk. `--correct-reference-bugs` opts into corrections of
known reference-renderer defects; today it starts opacity-shadow rays at the physical top face of a
block instead of almost one block above it. It is off by default so output matches the reference.
Both settings are recorded with the render settings: changing either one makes `--incremental` fall
back to a full render. A new blend radius also starts a new `--surface-cache` namespace; the shadow
correction does not change extracted surfaces, so cached surfaces stay valid.

The default zooms are -4..+2; explicit native +3 remains supported. For an overview-only selection,
use `--zooms=-4,-1`. Zoom-zero sources are rendered once and streamed from PNGs with alpha-weighted
area filtering. They are reused from the published inventory or kept temporarily within staging.
See the [overview contract](../../docs/2d-overviews.md) for grid, filtering and source-work details.

## Limits

### Validate without exporting

The existing entry also validates a snapshot without rendering, caches or an output directory:

```sh
node apps/render-cli/dist/index.js validate --world /srv/snapshots/world
node apps/render-cli/dist/index.js validate --world /srv/snapshots/world \
  --max-input-file-bytes 268435456 --max-decoded-block-bytes 16777216 \
  --max-total-input-bytes 34359738368 --timeout-seconds 300
node apps/render-cli/dist/index.js validate --help
```

It prints one JSON result on stdout, including failures; human diagnostics go to stderr.
Exit codes: **0** valid, **1** invalid/limited/timed out, **2** invalid invocation,
**130** SIGINT, **143** SIGTERM. Help is text and exits zero. These validation limits are
independent of the rendering options below. The API is `validateSnapshot` from
`@mapelix/core/node/snapshot`. See the [version-1 validation contract](../../docs/snapshot-validation.md)
for exact fields, read permissions, validation scope and release commands.

### Export limits

Every limit is checked before acceptance where possible, and errors have nonzero exit status.

| Option                   |      Default | Meaning                                                                    |
| ------------------------ | -----------: | -------------------------------------------------------------------------- |
| `--workers`              |            2 | Concurrent tile workers, 1..16; even one uses a worker                     |
| `--max-pending`          | Worker count | Accepted jobs including running renders and PNG writes, 1..1024            |
| `--max-tiles`            |        10000 | Published tiles plus temporary zoom-0 sources, before rendering            |
| `--max-output-bytes`     |   1073741824 | All new PNGs, including temporary sources, plus both manifests             |
| `--max-input-file-bytes` |    268435456 | Maximum size of any consumed database file or `level.dat`                  |
| `--timeout-seconds`      |          300 | Deadline covering validation, hashing, indexing, rendering and publication |
| `--memory-budget-mib`    |         2048 | Process-wide resident memory budget sampled every 25 ms                    |

Counts, bytes, worker counts and time options are positive safe integers. API callers can specify
`timeoutMs` directly. The pending-job limit may be lower than the worker count. It limits accepted
work rather than creating an additional unbounded queue. PNG and manifest sizes are checked before
their writes; a manifest-size failure discards the unpublished PNGs.

The coordinator owns indexing and the tile worker pool. The caller stays responsive to cancellation,
deadlines and memory samples even while indexing is CPU-bound. Cancellation requests an aborting
close, then terminates the coordinator and its nested workers after a 250 ms grace period. Cleanup
finishes before the API rejects or the command exits. Deadline plus grace and filesystem cleanup can
take longer than the configured deadline. No `process.exit()` is used.

RSS includes the main thread and all worker threads. This is a sampled application budget: native
allocations can overshoot between samples, and a system out-of-memory kill can occur first. Use an OS
or container memory limit when a hard memory ceiling is required. The file-size guard bounds the
reference indexer's single-file reads; it does not make the full index seekable. The memory budget
counts other work in the same process when the API is embedded.

The output-byte limit includes generated source PNGs even after they are removed, and excludes
existing exports and filesystem allocation overhead. Lock contents and filenames are metadata.
Quotas and retention belong to the host.

## Publication and files

The command exclusively creates `.mapelix.lock` under the output root and refuses to steal an existing
lock. It renders into a uniquely owned staging directory there. After checking tile dimensions, file
inventory, SHA-256 digests and source stability, it moves the completed payload into an immutable
content-addressed directory, then replaces the root manifest by a same-directory rename:

```text
<output>/manifest.json
<output>/generations/<sha256>/manifest.json
<output>/generations/<sha256>/<dimension>/tiles/<zoom>/<x>/<y>.png
```

The root `manifest.json` is the publication pointer. Readers see the previous complete export or the
new complete export, and resolve each tile as `tileBase + tile.path`. Pin a fetched manifest while
loading its tiles. The immutable directories are export payloads; deployment history, retention and
rollback policy remain the host's responsibility. No previously completed payload is deleted.

An ordinary error, timeout or cancellation leaves the previous pointer unchanged and removes only
the current run's staging files, temporary manifest and lock. If cancellation races the final rename,
a successful rename is the commit point and the call succeeds. A second identical export still
renders all requested tiles, verifies the existing immutable payload and publishes the same bytes.
With `--incremental`, tiles whose source chunks, shadow halo and biome-blend window are unchanged are
copied from the published generation instead; the result is byte-identical to a full render.
With `--surface-cache`, extracted chunk surfaces are also kept in `<output>/.mapelix-surface-cache`
(bounded, 512 MiB by default, `--surface-cache=<mib>` to change it), so the tiles that must be
rendered again only extract changed chunks. Deleting or damaging that directory never changes the
output; see `docs/2d-performance.md`.

All inputs and existing output components reject symbolic links and Windows junctions, including
linked database files. An unrelated or unsupported root manifest and a corrupt colliding immutable
payload are refused. The existing publication manifest has a 128 MiB read limit. The implementation
assumes a local filesystem with atomic same-directory replacement and exclusive ownership during
export. Portable Node filesystem APIs do not prevent a concurrent adversarial process from replacing
ancestors after validation. Network filesystems may have different rename semantics.

The temporary publication manifest is flushed before replacement. Individual PNGs and directory
entries are not all fsynced; atomic visibility does not guarantee recovery after power loss. A forced
process kill can leave an unpublished staging directory, payload or lock. Inspect and remove such
owned leftovers only after ensuring the writer has stopped; the command never guesses that a lock
is stale. The previously published pointer remains independent of those staging files.
Filesystem errors during cleanup are reported as an `AggregateError` and can also leave owned files;
the error includes any original failure. Publication may already have completed in that case.

## Manifest version 1

The exported TypeScript contracts are `BatchManifest`, `PublishedBatchManifest` and `BatchTile` from
`@mapelix/core/node/batch`.

| Field                                 | Contract                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `format`, `schemaVersion`, `complete` | `"mapelix-2d"`, `1`, `true`; refuse unknown versions                                                                         |
| `renderer`                            | Package name, version and content revision of compiled 2D code plus Node/zlib runtime                                        |
| `resources.appearanceSha256`          | Derived shared modern top-view appearance profile digest                                                                     |
| `source`                              | Revision and sorted `{path, bytes, sha256}` identities for consumed `.ldb`/`.sst`/`.log` files and optional `level.dat`      |
| `grid`                                | XYZ, 256 pixels, X east, Y south, `pixelsPerBlock = 2^zoom`, requested zoom list and optional overview filter                |
| `render`                              | Dimension profiles and exact included cuts, appearance, shadows, biome blend, reference correction and optional block bounds |
| `tileCount`, `pngBytes`               | Inventory count and total PNG bytes                                                                                          |
| `tiles`                               | Sorted `{dimension,z,x,y,path,bytes,sha256}` entries; dimension/zoom/X/Y order                                               |
| `generation`, `tileBase`              | Root pointer only; immutable-manifest digest and relative payload base                                                       |
| `work`                                | Overview exports only: planned tile jobs, temporary source count and temporary PNG bytes                                     |

The generation is the SHA-256 of the exact UTF-8 immutable manifest (two-space JSON plus a newline).
It excludes the root pointer's `generation` and `tileBase` to avoid a recursive digest. Input/output
absolute paths, dates, elapsed time, worker counts and limits are excluded. Changing render settings,
source bytes, 2D engine code or PNG runtime changes the identity. The code revision does not require
Git at runtime and does not include the scene/viewer packages. Physical source hashes can change
after a database compaction even when the resulting terrain is identical.

The source is hashed before indexing and again after rendering. A changed inventory or content
rejects the export. This detects ordinary snapshot mutation; it is not a transactional snapshot of a
live database. The inherited reader does not interpret LevelDB manifests and does not comprehensively
validate all checksums. It does not read archives directly. Snapshot creation stays outside the tool.

`--bounds=x0,z0,x1,z1` intersects the plan using exclusive block bounds, within +/-30000000. Every
intersecting tile remains a full 256px image with normal XYZ alignment. Negative coordinates use floor
division. Whole overview tiles also include their stored source cells outside the requested bounds.
Zooms -4..+2 are the default; explicit +3 is compatible. Incremental updates are described in
[2D export performance](../../docs/2d-performance.md).

## Exit contract and validation

Successful stdout contains exactly one JSON summary with manifest path, generation, tile count,
PNG bytes, elapsed milliseconds and sampled peak RSS. Diagnostics use stderr. SIGINT and SIGTERM
request cancellation, with exit codes 130 and 143; other failures use 1. No background service remains.

```sh
pnpm exec turbo run build check lint test:unit --filter=@mapelix/render-cli --filter=@mapelix/core
```

Tests cover real worker option transport, deterministic one/two-worker output, all dimensions,
negative sparse planning, path confinement/junctions, lock ownership, existing publication integrity,
tile/file/output/memory/time limits, cancellation and forced termination of CPU-bound nested workers.
Child processes verify natural exit after successful rendering and errors.
