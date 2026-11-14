# Discovery navigation and keyboard follow-up

Viewer changes following `974f715`. Engine packages are unchanged. No HTTP,
region format, discovery schema or cache-key revision changes are required.

The Surface/keyboard corrections in `e5881b3` add no public options or methods.
Hosts only need to update the descent hint from Shift to C and keep using
`focusDiscovery` and the existing context callback. Source cache identities and
configurable URL bases/`.bin` suffixes are preserved.
The subsequent optional `formatDiscoveryLabel` option and roofed-container
visibility are described in [immediate discovery labels](discovery-labels.md).

## Keyboard and selection tools

In Caves, Space ascends and C descends. Page Up/Down remain compatible aliases.
Shift has no camera action; repeated/held Shift can open Windows accessibility
dialogs and cannot be reliably intercepted by a page. Vertical keys are taken
only when the event belongs to the canvas,
its application container or the page body/document. Buttons, checkboxes,
sliders, selects, text/editable fields and host controls keep their own Space
handling. PreventDefault is called only when the camera consumes the key.

Keyup, blur, hidden document and focus entering host controls clear keyboard
input. Each held key also expires after 600 ms without a keydown/repeat event,
preventing lost keyups from causing indefinite travel. Horizontal keyboard speed
is capped at 96 blocks/s in Surface and 32 blocks/s in Caves, including diagonal
movement; vertical speed remains 12 blocks/s. Shift never swaps mouse actions: the viewer
compensates through MapControls' public mouse mapping, preserving Ctrl/Meta.
Right drag continues to orbit; left drag pans. No acceleration uses Shift.

The X/Z Move/Resize tools do not use Shift, including their Three.js control.
Their drag callback suspends camera input and clears held keys. Regression tests
hold Shift while resizing and verify that camera Y stays unchanged.

## Surface resources and depth classification

The same snapshot-based 32×32 all-height source tiles serve both views. Filtering
is entirely in the viewer; changing the height checkbox at a fixed location
does not change source URLs or require another index build/request for cached
tiles. Filters, display limits and source-cache budgets remain in force.

In Surface, with **Search all heights** off, only positively verified exterior
blocks are retained. Enabling it also includes covered blocks. This local
filter yields every 256 scanned blocks and shares the existing 2 ms grouping
budget. Source packets are never modified. In Caves, the checkbox keeps its
existing meaning: the current slice, or all saved heights.

The exact rule requires saved `exposed` status and either an exact column top
`columnTop === blockY + 1`, or an actual LOD-0 side face owned by that voxel,
facing an adjacent column whose exact top is at or below `blockY + 1`. This
retains exposed cliff/bank faces while rejecting cave faces beneath a roof.
There is no eight-block tolerance. Unknown heights, unknown exposure and coarse
LOD heights cannot certify visibility. Existing LOD-0 cached terrain is reused;
no extra terrain/index requests are forced. Distant markers may therefore appear
only after zooming in and loading exact terrain. Arrival or eviction of exact
terrain automatically invalidates derived groups and reuses cached source tiles.
Containers may additionally qualify through an actual owned face in the cached
LOD-0 Surface mesh, keeping visible rooms beneath roofs discoverable. Sealed
underground containers discarded by that mesh remain excluded; the ore rule
above is unchanged. Search all heights stays unchecked by default.

Activating discoveries never changes mode. From Surface, clicking a certified
exterior object stays in Surface; any other object opens its 16/32-block
cave window. From Caves, clicking an out-of-slice object opens another cave
window, even for an object near the world surface. There is **no automatic return
from Caves to Surface** in this change. Every changed window is reported through
`onDepthChange` with `mode: "caves"`, canonical minY/maxY and the legacy ceilingY
alias. The callback remains typed for a complete SceneContext; hosts should not
infer the mode from height signs. A manual Surface switch stays host-owned.
The last chosen 16/32-block thickness is retained when visiting Surface and
subsequently opening another discovery's cave window; a fresh viewer defaults to 32.

Every marker is projected at the real representative block center, never lifted
to terrain/water height. In all-height mode its DOM indicator remains selectable
even when terrain covers the source block. Coordinates/counts stay unchanged. A marker
or card is not proof that a fully buried block is represented in the mesh.

## Framing and one details card

`focusDiscovery(group): Promise<boolean>` is the complete navigation operation.
It preserves heading/pitch, centers the representative coordinates and approaches
moderately according to group size (nominal distance 18–40 blocks, retaining a
closer view for exposed representative blocks). Newly opened windows put the target in their
upper 16-block section where dimension bounds allow, reducing the overburden
above it. Without verified exposure for the selected representative,
the camera backs out toward/above the cut, capped at the existing
96-block cave orbit limit. It must not shorten a ray from inside buried rock:
that ray meets an exit face and would put the camera back into the terrain.
For exposed representative blocks, after terrain arrives it can shorten the same view ray to
avoid a loaded cave wall/ceiling, down to 1.5 blocks when needed. The orbit
pivot remains pinned to the selected point; Surface collision/height settling
does not lift it back to a roof. At very shallow viewing angles the bounded
orbit may not clear all surrounding rock; Recover view remains available.
This does not reveal fully enclosed source
blocks missing from the mesh. The marker/card retains their source information.

Only one group/card is retained. A new selection replaces it. Blank left/right
clicks, pan, vertical movement, zoom, selection-box manipulation, filter changes,
view changes and disposal clear it. Mouse orbit and Q/E retain it. Closing a card
does not turn off discovery filters and does not force a camera zoom jump.
Reapplying the same validated filter state is a no-op, so host synchronization
does not dismiss the newly focused discovery or restart its grouping.

A pointer click on a marker returns focus to the canvas, so Space can ascend
instead of activating that button again. Tab/Enter/Space activation keeps the
marker keyboard-accessible and preserves its button focus.

If a remembered X/Z clip excludes the clicked point when entering Caves, it is
cleared so the point is not hidden. The host can read snapshot().selection during
the selection callback to synchronize its area controls.

`focusOn(point)` keeps its signature. Its behavior now preserves orientation,
approaches to at most 24 blocks (or retains a closer distance), pins the pivot
and checks loaded occlusion. It does **not** open another window or create a card
from coordinates alone. For discovery navigation and "Go there", use
`focusDiscovery(group)` instead of a separate setWorld/focusOn sequence.

## Optional host interface and callback order

Existing `onDiscoverySelect(group)` remains an **override**, preserving earlier
behavior. When supplied, a marker calls it without first navigating. When absent,
the viewer calls focusDiscovery itself. Do not use onDiscoverySelect as a
post-navigation notification; that would trigger duplicate navigation.

New optional WorldViewerOptions:

- `discoveryDetails?: boolean`: display the native card (default true). Set false
  when the host supplies its own card.
- `formatDiscoveryDetails?: (group) => { title, lines, closeLabel? }`: format the
  native card in the host language. All content uses textContent, not HTML. The
  translated title also labels the card for assistive technology.
- `onDiscoveryFocusChange?: (group | undefined) => void`: notification after
  framing, and undefined when dismissed. The host may show/update/close its own
  card and read snapshot().context/selection. It never needs to recenter again.

New methods are `focusDiscovery(group)` and `clearDiscoveryFocus()`. The latter
aborts pending discovery metadata and dismisses the active selection/card.
`snapshot().selectedDiscovery` exposes the active group or undefined. Detect
these additions when supporting older viewer builds. DiscoveryDetailText is
also exported from world-viewer.ts for optional type re-exports.

The existing `loadDepth(context, signal)` supplies metadata when another cave
window is needed, independently of whether automatic following is enabled. It
can construct the next WorldInfo from the current world description and context;
no new metadata HTTP route is required. Missing loaders return false for a
necessary transition. Stale, aborted, mismatched-context and changed-snapshot
responses are ignored/rejected. Manual setWorld or another camera action cancels
pending discovery navigation. Errors return false rather than applying partial
unrelated metadata.

For a successful transition, the order is:

1. Load and validate the exact metadata/context/snapshot.
2. Apply the window, frame the point and prepare its native card if enabled.
3. Call **onDepthChange(newContext)** once if the context changed. Update Explorer
   state only; never call setWorld again in response.
4. Call **onDiscoveryFocusChange(group)**. The context, camera and selection in
   snapshot() already describe the framed point. Later terrain arrival may
   shorten the camera distance along the same ray without another mode change.

```ts
const viewer = await WorldViewer.create(container, world, start, {
  ...existingOptions,
  loadDepth: loadHostMetadata,
  onDepthChange: (context) => updateExplorerContext(context),
  onDiscoverySelect: (group) => {
    void viewer.focusDiscovery(group);
  },
  formatDiscoveryDetails: (group) => ({
    title: `${frenchKindLabel(group.kind)} × ${group.count}`,
    lines: [`Position : ${group.x}, ${group.y}, ${group.z}`],
    closeLabel: "Fermer la découverte",
  }),
});
```

For a host-owned card, replace the formatter with discoveryDetails:false and
onDiscoveryFocusChange. No change to URL bases, .bin suffixes, API versions,
server routes, source/region revisions or production quotas is needed.

## Validation

Unit and browser regressions cover source reuse/filtering, exact depth boundaries,
negative Y, moderate framing, native French and host-owned cards, callback
ordering, one-card replacement, dismissal/orbit, keyboard focus/chords/visibility,
Shift gestures and X/Z resizing. The corrections following `fe82288` pass 52
viewer unit tests, build/type/lint checks, the complete 40-case browser suite,
and a final 12-case WebGPU/WebGL run after the mixed-group exposure and all-height
regrouping refinements. The unchanged
engine's 182 tests are reused from the verified Turbo cache.

Both backends complete 104 consecutive Surface/Caves/Nether/End switches.
Equivalent warmed checkpoints retain 18 textures; uniform buffers decrease
75→70 (WebGPU) and 77→72 (WebGL). The final 36-switch collected-heap differences
are 249,964 and 272,004 bytes, below the existing 512 KiB allowance. These are
logical renderer allocations and collected JS heap, not physical GPU residency
or VM RSS. Card disposal removes the single owned DOM section; no GPU resource
is added for the card. See the [measurement summary](benchmarks/surface-discovery-fixes-2026-11-13.json).

Browser servers are temporary; no local preview is left running and production
is not contacted. All worlds used in these checks are generated disposable
fixtures.
