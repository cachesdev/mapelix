<script lang="ts">
  import type { ViewerSnapshot } from "$lib/viewer/world-viewer";

  interface Props {
    snapshot: ViewerSnapshot;
    /** Terrain fades into the sky before the edge of the loaded area. */
    edgeFade: boolean;
    /** Streams out to `renderDistance` at every zoom. */
    customRenderDistance: boolean;
    /** Blocks to stream while `customRenderDistance` is on. */
    renderDistance: number;
    /** Lets the camera zoom out far past the usual limit. */
    zoomUnlocked: boolean;
  }

  let {
    snapshot,
    edgeFade = $bindable(),
    customRenderDistance = $bindable(),
    renderDistance = $bindable(),
    zoomUnlocked = $bindable(),
  }: Props = $props();

  const MIN_DISTANCE = 2_000;
  const MAX_DISTANCE = 100_000;
  const DISTANCE_STEP = 1_000;

  /** Applies a typed distance when the field is committed, within the slider's range. */
  function commitDistance(event: Event & { currentTarget: HTMLInputElement }): void {
    const typed = event.currentTarget.valueAsNumber;
    if (Number.isFinite(typed)) {
      renderDistance = Math.round(Math.min(Math.max(typed, MIN_DISTANCE), MAX_DISTANCE));
    }
    event.currentTarget.value = String(renderDistance);
  }

  const rows = $derived([
    ["Renderer", snapshot.backend],
    ["Frame rate", `${snapshot.framesPerSecond.toFixed(0)} fps`],
    ["Regions drawn", String(snapshot.streaming.drawn)],
    ["Regions cached", String(snapshot.streaming.cached)],
    ["Quads drawn", `${(snapshot.streaming.quads / 1e6).toFixed(2)} M`],
    ["Loading", `${snapshot.streaming.loading} of ${snapshot.streaming.remaining}`],
    ["Quad memory", `${snapshot.streaming.megabytes.toFixed(1)} MiB`],
    ["Camera distance", `${snapshot.view.distance.toFixed(0)} blocks`],
  ]);
</script>

<aside class="glass debug" aria-label="Rendering statistics and options">
  <dl class="numeric">
    {#each rows as [name, value] (name)}
      <dt>{name}</dt>
      <dd>{value}</dd>
    {/each}
  </dl>

  <div class="options">
    <label>
      <input type="checkbox" bind:checked={edgeFade} />
      <span>Edge fog</span>
    </label>
    <label>
      <input type="checkbox" bind:checked={zoomUnlocked} />
      <span>
        Unlock zoom out
        <small>Experimental. Loads much more of the world.</small>
      </span>
    </label>
    <label>
      <input type="checkbox" bind:checked={customRenderDistance} />
      <span>
        Custom render distance
        <small>Experimental. Destroys your PC's performance.</small>
      </span>
    </label>
    {#if customRenderDistance}
      <div class="distance">
        <input
          type="range"
          min={MIN_DISTANCE}
          max={MAX_DISTANCE}
          step={DISTANCE_STEP}
          bind:value={renderDistance}
          aria-label="Render distance"
        />
        <input
          class="numeric"
          type="number"
          min={MIN_DISTANCE}
          max={MAX_DISTANCE}
          step={DISTANCE_STEP}
          value={renderDistance}
          onchange={commitDistance}
          aria-label="Render distance in blocks"
        />
        <span>blocks</span>
      </div>
    {/if}
  </div>
</aside>

<style>
  .debug {
    padding: 12px 14px;
    font-size: 12px;
  }

  dl {
    display: grid;
    grid-template-columns: auto auto;
    gap: 5px 18px;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    text-align: right;
  }

  .options {
    display: grid;
    gap: 8px;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--panel-border);
  }

  label {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    cursor: pointer;
  }

  input {
    margin: 1px 0 0;
    accent-color: var(--accent);
    cursor: pointer;
  }

  .distance {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 21px;
    color: var(--muted);
  }

  .distance input[type="range"] {
    width: 120px;
    margin: 0;
  }

  .distance input[type="number"] {
    width: 72px;
    margin: 0;
    padding: 3px 6px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    background: rgb(255 255 255 / 0.06);
    cursor: text;
  }

  label span {
    display: grid;
    gap: 2px;
  }

  small {
    color: var(--warning);
    font-size: 11px;
  }
</style>
