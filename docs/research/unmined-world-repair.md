# uNmINeD recovery of the Amelix world copy

**Checked:** 2026-08-17.  This records a recovery experiment against a copy
only.  It did not modify the source world.

## Result

The official uNmINeD CLI successfully rendered the requested native-detail
tile as a lossless PNG after a classic LevelDB manifest reconstruction.

Output:

```text
.local/tools/unmined-world-repair-20260817/
  unmined-classic-z2-x-32-y-49.png
```

The output is a 256 x 256, 8-bit RGBA PNG.  Its SHA-256 is:

```text
b7fa6e1d31df0e9a76333ea941103b4725751fe0a892bffd8070c40fb69a203b
```

This replaces the published JPEG as the best base image for renderer
comparison.  Keep it outside Git: it derives from the private world backup.

## Exact render command

The render command used the published updater settings that are available to
the CLI: native zoom 2, `3do` shadows, the published background, and one
chunk processor.  PNG output selects lossless output from the file extension.

```sh
unmined-cli image render \
  --world=.local/tools/unmined-world-repair-20260817/world-classic \
  --output=.local/tools/unmined-world-repair-20260817/unmined-classic-z2-x-32-y-49.png \
  --area='b(-2048,-3136,64,64)' \
  --zoom=2 \
  --shadows=3do \
  --background='#78a7ff' \
  --chunkprocessors=1 \
  --log-level=information
```

It opened the world, indexed 484,394 chunks in three dimensions, selected
region `rr(-4;-7)`, rendered 36 chunks, and exited 0.  The measured total was
6.85 seconds with 378,984 KB maximum RSS.

## Failure and cause

The untouched copy failed deterministically before rendering:

```text
System.IO.InvalidDataException: File 32439120 marked as removed not found in level 3
```

The source database control-file hashes were:

```text
CURRENT             41cdd0e35bacbe8ad06bc105b5f4d2c41e96e7b1daac1be39d9691292ed273bc
MANIFEST-32430469   3a41a7f5802d79bfb0768537df7340908624e09cff7dcd2d3b8132eee8cde76b
```

The world contains 556 top-level `.ldb` files and live log `32775755.log`.
The manifest refers to a table which the snapshot does not contain.  uNmINeD
strictly applies deletion entries, so it aborts even though the remaining
tables can still be read.

## Recovery procedure

1. Made a physical copy of `db`, `level.dat`, `level.dat_old`, and
   `levelname.txt` at
   `.local/tools/unmined-world-repair-20260817/world-classic`.
   The original source hashes above were rechecked after the experiment.
2. Tested `rocksdb_repair_db` from uNmINeD's bundled RocksDB 11.1 library.
   It completed in 0.19 seconds and 35,756 KB RSS, but its new manifest made
   uNmINeD fail with `Unknown manifest tag type: 8193`.  This is a format
   mismatch: uNmINeD's Bedrock LevelDB reader accepts classic LevelDB
   VersionEdit tags, not newer RocksDB manifest records.
3. Built a replacement *classic LevelDB* manifest in the copy.  The script is
   `.local/tools/unmined-world-repair-20260817/rebuild-classic-manifest.mjs`.
   It scans each valid table footer and index, gets its smallest and largest
   internal keys, writes one full LevelDB log record with the comparator,
   current log number, next file number, and 556 level-0 `NewFile` entries,
   then points `CURRENT` to `MANIFEST-99999999`.
4. The generated manifest is 22,035 bytes and has SHA-256:

   ```text
   a0e8832aa6505f7b6cbb6eefdc6ba18e8327cde2dc977afa5ea9b3ec2ee1b86e
   ```

This recovery is deliberately conservative: it preserves every top-level
table and the active log.  It does not claim to restore the missing table or
the original compaction-level layout.  It is valid for uNmINeD comparison
rendering, not a repair that should be given to Minecraft or used as a
canonical world backup.

## Verification against the published tile

The public JPEG reference downloaded from the published viewer has SHA-256:

```text
ba3ec6a3667a02ea0b1a90ee82418975ae0d3557277a1ca25a0625b3b3d6bb60
```

The existing structural comparison command was:

```sh
pnpm --filter @mapelix/core diagnose:compare \
  .local/tools/unmined-world-repair-20260817/unmined-classic-z2-x-32-y-49.png \
  .local/tools/unmined-world-repair-20260817/published-z2-x-32-y-49.jpeg \
  .local/tools/unmined-world-repair-20260817/repaired-vs-published-edges.png \
  4
```

It found the best edge offset at `(0, 0)`, with 0.8852 luminance correlation,
0.8757 exact-edge precision, and 0.7483 exact-edge recall.  With one-pixel
tolerance, precision was 0.9632 and recall was 0.9399.  That strongly supports
correct tile alignment and useful world content.  Differences remain expected:
the public image is JPEG, may come from a different saved state, and the
reconstructed manifest has only an approximate record-precedence order.

## Reproducible alternative

If the temporary copy is removed, repeat the physical copy then run:

```sh
node .local/tools/unmined-world-repair-20260817/rebuild-classic-manifest.mjs \
  /path/to/copied-world/db
```

Use the exact render command above.  Do not run the script on the original
world.  If the recovered tile ever shows materially different structures,
use Mapelix's direct record scan as the source of truth and treat this
official uNmINeD result as a lighting/oracle image only.
