# Read-only snapshot validation — contract version 1

## Minimum supported release

Requires Node.js 24 or later and a release declaring `snapshotValidationVersion: 1` in
`release.json`. Package version `0.0.0` does not identify this capability. Pin the approved clean
release's full `commit`, require `dirty: false`, and verify its file hashes before executing it.
Support begins with the first clean release declaring this capability. Use `release.json.commit`
to pin the exact build.

Region format 4, viewer embed API 5 and tile manifest schema 1 are unchanged.

## Node API

```ts
import { validateSnapshot } from "@mapelix/core/node/snapshot";

const controller = new AbortController();
const result = await validateSnapshot("/srv/snapshots/world", {
  maxInputFileBytes: 268_435_456,
  maxDecodedBlockBytes: 16_777_216,
  maxTotalInputBytes: 34_359_738_368,
  timeoutMs: 300_000,
  signal: controller.signal, // Optional AbortSignal supplied by the caller.
});
if (!result.valid) throw new Error(result.errors[0]!.message);
```

```ts
declare function validateSnapshot(
  directory: string,
  options?: {
    readonly maxInputFileBytes?: number;
    readonly maxDecodedBlockBytes?: number;
    readonly maxTotalInputBytes?: number;
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
  },
): Promise<SnapshotValidationResult>;
```

The lightweight entry does not import rendering or cache modules. The same API is re-exported
by `@mapelix/core/node`. Invalid snapshots, cancellation and timeouts resolve to `valid: false`.
Invalid API arguments reject with TypeError or RangeError. Limits must be positive safe integers;
`timeoutMs` is at most 2,147,483,647. Defaults are the values in the example.

## CLI commands

From a built checkout:

```sh
node apps/render-cli/dist/index.js validate --world /srv/snapshots/world
node apps/render-cli/dist/index.js validate --world /srv/snapshots/world \
  --max-input-file-bytes 268435456 --max-decoded-block-bytes 16777216 \
  --max-total-input-bytes 34359738368 --timeout-seconds 300
node apps/render-cli/dist/index.js validate --help
```

From a self-contained release:

```sh
node /srv/mapelix/node_modules/@mapelix/render-cli/dist/index.js validate \
  --world /srv/snapshots/world
```

This extends `mapelix-render`; existing rendering invocations remain valid. Validation accepts
no output directory. Integer CLI limits override the corresponding API defaults; timeout is in
seconds. Stdout contains one versioned JSON result for validation and invocation failures, with
human diagnostics on stderr. `validate --help` is text and exits zero.

| Exit | Meaning |
| ---: | --- |
| 0 | Valid snapshot |
| 1 | Invalid snapshot, I/O failure, resource limit or deadline |
| 2 | Invalid invocation or option |
| 130 | SIGINT handled; result reports cancellation |
| 143 | SIGTERM handled; result reports cancellation |

## Result schema

| Field | Contract |
| --- | --- |
| `format` | `"mapelix-snapshot-validation"` |
| `schemaVersion` | `1`; consumers must reject unsupported versions |
| `valid` | Boolean; true only after every required check and the final consistency pass |
| `revision` | 64 lowercase SHA-256 hex characters on success, otherwise null |
| `activeTables`, `selectedJournals`, `ignoredTables` | Nonnegative counts; null if selection failed |
| `filesChecked`, `bytesChecked` | Completed files and logical bytes; exclude the final consistency re-read |
| `elapsedMs` | Observed elapsed milliseconds; not part of the content revision |
| `errors` | Empty on success; exactly one `{ code, file, message }` on failure |

`file` is a path relative to the world, or null before a file is selected. Messages are human
diagnostics, not a parsing contract. Validation is fail-fast and does not enumerate every fault.
The revision equals the 2D export's `source.revision`: sorted selected file identities, including
CURRENT, its manifest and optional `level.dat`. It ignores inactive tables and obsolete journals.
The 3D revision retains its separate engine/mtime-based format; it uses the same selected files.

Error codes: `CURRENT_INVALID`, `MANIFEST_INVALID`, `MANIFEST_UNSUPPORTED`,
`ACTIVE_FILE_MISSING`, `ACTIVE_TABLE_INVALID`, `REQUIRED_LOG_INVALID`, `SNAPSHOT_IO_ERROR`,
`SNAPSHOT_LIMIT_EXCEEDED`, `SOURCE_CHANGED`, `VALIDATION_CANCELLED`, `VALIDATION_TIMEOUT`,
and CLI-only `VALIDATION_OPTIONS_INVALID`.

## Exact scope and permissions

- Uses the same CURRENT/manifest selector as 2D, 3D, extent scans and source revisions; there is
  no second manifest parser or fallback to decoding every file in the folder.
- Checks manifest physical records, CRC32C, VersionEdits and supported comparator/tags; replays
  table membership and selects recovery journals by LogNumber/PrevLogNumber.
- Checks each active table's logical length, footer, data/index/metaindex/filter block CRCs,
  supported compression, handles, non-overlap, restart arrays, key ordering, separators,
  tombstone representation, filter offsets and exact manifest key bounds. Filter-policy payloads
  remain opaque. Block and filter framing follow the [LevelDB table format](https://github.com/google/leveldb/blob/main/doc/table_format.md).
- Checks every selected WAL's framing, fragmentation, CRCs, write-batch structure, sequence range,
  entries and tombstones. Recent writes are not capped at manifest LastSequence. Unselected table
  contents and obsolete WALs are never opened.
- Reads and hashes optional `level.dat` as opaque metadata; neither its NBT semantics nor Bedrock
  record payloads, block palettes, entities or rendering compatibility are validated.
- Re-hashes the selected source after validation to detect observed changes. This does not make
  an atomic snapshot of a changing database: the host must supply an immutable extracted snapshot.

Access requires traversal of parent directories, listing the world/database directories, and
reading CURRENT, its manifest, selected tables/journals and optional `level.dat`. No write or
elevated permission is required; inactive tables need no content-read permission. Input links and
junctions are rejected. No repair, compaction, lock creation, rendering, cache or export is run.
No chmod, ownership or ACL changes are performed. Read access times can be maintained by the
filesystem; content, modes and modification/change times are preserved by the validator.

The per-file limit applies to logical table lengths and physical metadata/WAL lengths. CURRENT
also has a 4 KiB cap and manifests a 64 MiB cap. Decoded block limits bound Snappy allocation
and native deflate output. One selected file is read at a time. Limits do not constitute a hard
RSS ceiling. Deadlines/cancellation are cooperative between bounded reads, records and blocks;
the host retains its hard process/time/memory limits and failure cleanup.

## Release descriptor and shipped files

```json
{
  "snapshotValidationVersion": 1,
  "snapshotValidationApi": "node_modules/@mapelix/core/dist/node/snapshot.js",
  "snapshotValidationCli": {
    "entry": "node_modules/@mapelix/render-cli/dist/index.js",
    "args": ["validate"]
  }
}
```

The release ships compiled core `node/snapshot.js` and `node/snapshot-identity.js`, prototype
`node-leveldb.js` and the portable `bedrock/leveldb-snapshot.js`, `leveldb-log.js`,
`table-validation.js` and record decoder, plus the existing CLI entry and `snapshot-cli.js`.
All modules, package manifests and existing runtime dependencies are covered by `files` SHA-256
digests in `release.json`. No new runtime dependency or texture is added. Runtime releases contain
compiled JavaScript; TypeScript declarations remain available in the built checkout.

## Host integration

Delegate the existing table-content prevalidation to this API or CLI. Keeping an independent loop
that decodes every archived `.ldb` before delegation would still reject unfinished inactive files.
Keep BDS announced-length/inventory checks, archive hashes, safe extraction and path confinement,
snapshot stability and ownership, release verification, resource limits, successful export/prewarm
checks, atomic publication, the last valid map and controlled 3D service stop/restart. LevelDB
validation does not replace those protections or imply that opaque Bedrock payloads can render.

## Tested JSON examples

A generated snapshot with one necessary WAL and an ignored unfinished table:

```json
{
  "format": "mapelix-snapshot-validation",
  "schemaVersion": 1,
  "valid": true,
  "revision": "ac87eb0610d772195ffb431ab99a98018891b0cbdff8cb58c2e34c101ee2ab4d",
  "activeTables": 0,
  "selectedJournals": 1,
  "ignoredTables": 1,
  "filesChecked": 3,
  "bytesChecked": 2146,
  "elapsedMs": 27.31,
  "errors": []
}
```

After corrupting the necessary WAL (CLI exit 1):

```json
{
  "format": "mapelix-snapshot-validation",
  "schemaVersion": 1,
  "valid": false,
  "revision": null,
  "activeTables": 0,
  "selectedJournals": 1,
  "ignoredTables": 1,
  "filesChecked": 2,
  "bytesChecked": 29,
  "elapsedMs": 10.43,
  "errors": [
    {
      "code": "REQUIRED_LOG_INVALID",
      "file": "db/000001.log",
      "message": "000001.log: 000001.log: invalid LevelDB log record length"
    }
  ]
}
```
