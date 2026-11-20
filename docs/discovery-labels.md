# Immediate discovery labels

Viewer-only additions following `e5881b3`. No server, region format, discovery index, URL base,
`.bin` suffix or cache identity changes are required.

## Optional host formatter

`WorldViewerOptions` adds one optional option:

```ts
formatDiscoveryLabel?: (group: DiscoveryGroup, kind: DiscoveryKind) => string;
```

The returned string is shared by the marker's `aria-label` and its immediate
visual label. The host receives the actual group and kind, including `kind.id`.
Mapelix defaults to the existing English text, for example:
`Chest · 2 blocks · X -61, Y 69, Z 29`. Default labels, code and documentation
remain English; hosts supply their own localization.

```ts
const options: WorldViewerOptions = {
  ...existingOptions,
  formatDiscoveryLabel: (group, kind) =>
    `${hostKindName(kind.id)} ×${group.count} · Y ${group.y}`,
};
```

There are no new public methods. Existing selection callbacks, details cards,
framing and context notification order are preserved.

## Interaction and ownership

Each viewer owns one reusable label element with inline styles. Mouse entry and
keyboard focus show it synchronously. The label follows the projected marker,
prefers the space above it, flips below near the upper edge and stays within the
canvas. It never receives pointer events. Marker buttons have no native `title`,
preventing delayed duplicate labels. The accessible name supplies the same text
without a duplicate screen-reader announcement from the visual bubble.

Mouse leave, blur, marker hiding/removal, context changes and disposal hide the
label and clear its marker reference. Disposing the viewer removes the element.
Touch entry/focus never creates a bubble; tapping still selects the discovery
and opens its card. The formatter's output uses `textContent`, never HTML.

## Surface containers beneath roofs

With Search all heights unchecked, source-exposed containers can also qualify
through an actual owned face in the cached LOD-0 Surface mesh. This covers
chests, adjacent chest pairs and barrels in rooms beneath a roof without
changing the mesher's existing exterior/room visibility rules. Faces discarded
by Surface meshing cannot certify a container; sealed underground rooms remain
excluded. Unknown/coarse geometry also cannot certify one.

Ores and other categories retain the strict exact-height exterior rule from
`e5881b3`. Clicking a certified room container stays in Surface. No additional
terrain/index requests are forced, and the all-height source cache is reused.
Search all heights remains **off by default**, with saved preferences and shared
URL choices preserved. A fully sealed room culled by the existing Surface mesher
still needs an explicit all-height search or its cave slice.

## Validation

Build, type and lint checks pass, with 55 viewer unit tests. The unchanged
engine's 182 tests are reused from the verified Turbo cache. All 26 targeted
browser regressions pass on WebGPU and WebGL, covering dimensions, source-cache
reuse, buried-ore exclusion, roofed chest pairs/barrels, closed-cave containers,
immediate hover, keyboard focus, label flipping/tracking, map clicks/drags,
touch selection, context cleanup and disposal. Browser worlds are generated,
disposable fixtures.
