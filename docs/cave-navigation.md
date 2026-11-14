# Cave navigation and automatic depth

Incremental viewer work based on `92351d9`. Viewer only: no server, region
format or cache-key change.

## Navigation

Surface camera collision and retargeting remain active. In explicit Caves mode,
the camera moves through rock without collision or automatic retargeting onto a
nearby wall. This avoids the oversized collision sweep and wall pivot that could
trap exploration in a narrow cavern. The orbit focus stays within the visible
slice; the camera can stand above the cut for an overview.

Space/C move the camera and focus vertically at 12 blocks/second.
Page Up/Page Down remain aliases. Shift has no camera action; it never swaps
mouse pan/orbit. Space never takes over focused buttons or form controls.
The prototype also supplies 44-pixel touch buttons held to ascend/descend. Input
stops on release, cancellation, lost capture, blur, hidden document, selection
drag or manual view switch. Text/number/select/contenteditable fields keep their
keyboard input. Existing WASD/QE/RF controls are preserved. Keys expire after
600 ms without a keydown/repeat, protecting against a lost keyup. Translation
is capped at 96 blocks/s in Surface and 32 in Caves, independently of zoom.

Recover view stops movement, cancels pending automatic metadata, turns off the
selection tool and restores a distance of 80 and pitch of 60 degrees around the
current slice midpoint. X/Z, heading, selection and discovery preferences remain.
Explicit camera placement drains old control damping before applying the pose.

## Automatic following and limits

The host opts into automatic depth with a metadata loader. It is disabled by
default for embedded consumers; the local prototype enables it initially.
The local `autoDepth=0|1` URL parameter overrides the optional browser preference
`mapelix-auto-depth-v1`. Manual slicing continues to work.

Only held vertical input near a boundary requests the adjacent 16-block step.
Thickness remains 16 or 32 (default 32), bounds remain section-aligned and maxY
remains exclusive. A 32-block window starts following within four blocks of its
last visible block, retaining overlap and camera pose. A 16-block window changes
at the last visible block; the focus moves by at most one block into its neighbor.
Movement stops at dimension limits and cannot widen the slice.

Following requires 250 ms of held intent, a settled terrain streamer and at least
2000 ms between metadata requests (configurable, minimum 1000). Only one metadata
request may be pending. It is aborted on manual `setWorld`, disable, recovery and
disposal; late replies are ignored. Incorrect contexts and changed snapshot
revisions are rejected before releasing terrain. No adjacent-window prefetch or
additional worker pool is created. Applying a slice releases the previous
streamer's meshes and requests, reusing the existing bounded mesh pool.

Caves and discovery source downloads share **two concurrent slots**, including
body download. A 429/503 `Retry-After` (seconds or HTTP date) pauses both kinds of
download, including queued requests. Other failures use bounded exponential
backoff (1–30 seconds). Retry state retains at most 256 URL keys. Cancelled queued
jobs detach listeners; disposal releases their promises and timers. Surface
streaming retains its existing parallelism. The proxy continues to own the
90/minute visitor limit; the viewer waits for its advertised retry delay.

Source discovery packets/cache identities remain independent of depth. Existing
encoded/GPU budgets, LOD 0/1 and maximum 128-block cave reach are unchanged.
There is no server change, region/discovery format change or cache-key revision.
Already cached regions remain valid.
A server that fingerprints the two engine packages keeps its region revision,
since this change does not modify them: a viewer-only update needs no region
cache invalidation.

## Optional host additions

No existing option, method signature, HTTP API or binary interface is removed or
changed. All additions are optional for the host; detect methods and the new
snapshot field when supporting older viewer builds.

New `WorldViewerOptions`:

| Option                                            | Meaning                                                                                                                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadDepth(context, signal): Promise<WorldInfo>`  | Host metadata loader using its own URL base/authentication. Return canonical metadata for exactly that context and current snapshot. Honor the abort signal.                                                                            |
| `autoDepth?: boolean`                             | Initially enable following; defaults to false. Has no effect without a loader.                                                                                                                                                          |
| `autoDepthIntervalMs?: number`                    | Minimum request interval, default 2000, at least 1000.                                                                                                                                                                                  |
| `onDepthChange?: (context: SceneContext) => void` | Called after a successful automatic transition or discovery navigation that changes context. Includes dimension, mode, minY, exclusive maxY and ceilingY. Update host controls/state; do not call setWorld again for this notification. |

New methods:

| Method                           | Meaning                                                                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `setVerticalMovement(direction)` | Hold descent (-1), stop (0), ascent (1). Always send 0 on release/cancel/lost capture, blur and control unmount. No effect outside Caves. |
| `recoverCamera()`                | Restore the cave overview and clear movement/pending follow.                                                                              |
| `setAutoDepth(boolean)`          | Enable/disable following; disabling aborts pending metadata.                                                                              |

`snapshot().navigation` adds `available`, `autoDepth`, `loading` and optional-value
`error`. Older builds lack it. These additions need no new server routes.
The existing `snapshot().context` always reports the active canonical bounds.

```ts
const viewer = await WorldViewer.create(container, world, start, {
  ...existingOptions, // preserve region/discovery base paths and .bin suffixes
  loadDepth: (context, signal) => loadHostMetadata(context, signal),
  autoDepth: savedAutoDepth,
  onDepthChange: ({ minY, maxY }) => updatePanelDepth(minY, maxY),
});
if (typeof viewer.setVerticalMovement === "function") {
  // Wire host touch controls; the embedded class does not inject its own buttons.
}
```

The Svelte prototype owns its own buttons; an embedding host supplies its own.
The host loader can construct the next `WorldInfo` from its current world
description plus the requested context; no extra HTTP request is necessary when
that description and snapshot remain current.
For a manual metadata load, temporarily call `setAutoDepth(false)` before the
request, call the existing `setWorld` after it completes, then restore the user's
follow preference. Persist that preference in the host's existing store. The
viewer does not write browser preferences for embedded consumers.

## Validation

Targeted browser checks cover real keyboard and touch input on WebGPU and forced
WebGL, preserved camera pose/canvas, manual preference reload, recovery, wall
collision bypass, one pending automatic request, host callbacks and stale reply
cancellation. Unit checks cover boundaries/negative Y, 16/32-block slices,
debouncing, error handling, concurrency, retry delays and queued resource cleanup.
Build, type checks and lint pass. The unchanged engine's 182 tests are reused
from the verified Turbo cache, and all 33 viewer unit tests pass. The full browser
run passes 28 scenarios without failures, retries or skips. Four subsequent
targeted checks pass after the final mobile layout and custom-base test changes.
They include 320/430-pixel layouts and retained `.bin` URLs across auto-follow.

Each backend completes 104 Surface/Caves/Nether/End switches, with discoveries,
selection helpers and forced unpooled disposal after switch 52. Warmed equivalent
checkpoints (switches 20 to 104) give:

| Backend | Uniform buffers | Textures | JS heap           | Renderer allocation change |
| ------- | --------------- | -------- | ----------------- | -------------------------- |
| WebGPU  | 75 to 70        | 18 to 18 | 9.46 to 10.66 MiB | -54,672 bytes              |
| WebGL 2 | 77 to 72        | 18 to 18 | 9.56 to 10.85 MiB | -49,145 bytes              |

Additional shader/JS paths warm when the reuse pool is disabled. The final
36-switch heap differences are 401,432/414,108 bytes, within the existing 512 KiB
regression allowance. GPU counters remain stable; these are logical renderer
allocations and collected JS heap, not physical GPU residency or VM RSS.

On the user's copied snapshot, WebGPU follows an Overworld slice from -32..0 to
-16..16 and a Nether slice from 16..48 to 32..64, with discoveries enabled and
camera distance/angles preserved. Both visits observe at most two simultaneous
terrain/discovery downloads and no browser errors. All 1,895 source files retain
their SHA-256 hashes. End navigation uses generated fixtures, since this copy
contains no saved End chunks. See the [measurement summary](benchmarks/cave-navigation-2026-11-13.json).
