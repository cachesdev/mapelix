# LevelDB snapshot selection and integrity

Use a stable extracted Bedrock snapshot. Reading a live database while it changes is unsupported.
Mapelix never opens the database through a writable LevelDB instance: it does not repair, compact,
create locks, change permissions or remove files in the input directory.

## One selection for every reader

The 2D index, seekable 3D database, stored-area scan and source revisions share the same selection:

1. Read `db/CURRENT`, requiring one relative `MANIFEST-<number>` basename and a final newline.
2. Reconstruct that manifest's logical records from LevelDB's physical log frames. Check each
   frame's masked CRC32C, framing, fragmentation and complete payload.
3. Replay VersionEdits in order. Apply each edit's table removals before its additions, preserving
   file number, level, logical length and internal-key bounds. File numbers and sequences retain
   their full integer precision.
4. Open only the final active tables. Prefer the canonical `.ldb` name, with legacy `.sst` as a
   fallback. Unreferenced tables are counted but their contents and permissions are never inspected.
5. Recover numbered `.log` files whose number is at least `LogNumber`, plus a nonzero
   `PrevLogNumber` when present, in numeric order. Obsolete journals are ignored.

The byte-oriented parser lives in `@mapelix/prototype/bedrock` and has no filesystem dependency.
The shared read-only Node adapter is `@mapelix/prototype/node/leveldb`. No additional runtime
dependency is needed.

The supported VersionEdit tags are comparator, log number, next file number, last sequence,
compact pointer, deleted file, new file and previous log number. The comparator must be
`leveldb.BytewiseComparator` when specified; levels are 0 through 6. An unknown tag or comparator
is an explicit unsupported-manifest error. Missing metadata, invalid internal-key bounds, invalid
CRCs and incomplete records fail. No failure switches to opening every table in the folder.
`CURRENT` is bounded to 4 KiB and the manifest to 64 MiB; a caller's smaller input-file limit
also bounds the manifest.

## Records and logical lengths

The highest sequence number wins for each key, including tombstones. Journal writes can be newer
than the manifest's `LastSequence`: recovery does not discard them. Deletions suppress older table
values. The stored-area scan remains conservative: older versions of a deleted chunk can widen
the extent, which only adds empty coverage.

Tables use the logical length recorded in the manifest. A shorter file is an error; bytes after
that logical end are never decoded or hashed into the 2D source identity. Block handles and reads
are bounded by the logical table. Supported block compression tags are none, Snappy, zlib and
raw deflate. Directory readers verify encoded block CRCs before decoding.

The 2D reader still indexes one file at a time and loads tile values as needed. The 3D reader
still opens table indexes and reads data blocks on demand. Consequently, opening a 3D world is
not an exhaustive integrity check of every data block: unread corrupt blocks fail when requested.
A whole-snapshot validation entry must visit every required block, including metadata, rather than
equate a successful lazy open with complete validation.

The explicit byte-file helpers keep their legacy checksum-optional contract for callers that
already supply selected files; directory adapters always request checksum verification.

## Revisions and compatibility

The 2D source inventory now includes `CURRENT`, its designated manifest, the active tables' logical
bytes, selected journals and optional `level.dat`. The 3D revision reads the same metadata and
uses only selected file names, logical lengths and modification times, plus the engine identity
and optional `level.dat`. Adding or removing inactive tables, obsolete journals, `LOCK`, diagnostic
logs or other manifests does not change either revision.

An engine upgrade changes the engine fingerprint as usual, so old cached regions are regenerated.
No tile manifest schema, binary region format, request URL or viewer API change is required.

Reader failures expose `LevelDbSnapshotError` with `code`, `file` and `message`. Codes distinguish
`CURRENT_INVALID`, `MANIFEST_INVALID`, `MANIFEST_UNSUPPORTED`, `ACTIVE_FILE_MISSING`,
`ACTIVE_TABLE_INVALID`, `REQUIRED_LOG_INVALID`, `SNAPSHOT_IO_ERROR` and `SOURCE_CHANGED`.
These details do not replace snapshot immutability or the host's acquisition and publication checks.
