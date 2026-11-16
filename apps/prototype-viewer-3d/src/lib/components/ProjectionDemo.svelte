<script lang="ts">
  import type { AutoPerspective, ViewerSnapshot } from "$lib/viewer/world-viewer";

  interface Props {
    snapshot: ViewerSnapshot;
    /** Called whenever a rule or threshold changes; undefined turns every rule off. */
    onrules: (rules: AutoPerspective | undefined) => void;
    onscale: (pixelsPerBlock: number) => void;
    onpitch: (degrees: number) => void;
  }

  let { snapshot, onrules, onscale, onpitch }: Props = $props();

  const DEGREES = Math.PI / 180;
  /** Pixels per block of 2D map zoom levels -2 to +4. */
  const SCALES = [0.25, 0.5, 1, 2, 4, 8, 16];
  const PITCHES = [80, 45, 30, 15, 8];

  let zoomRule = $state(false);
  let zoomThreshold = $state(16);
  let pitchRule = $state(false);
  let pitchThreshold = $state(20);

  $effect(() => {
    const rules: AutoPerspective = {
      ...(zoomRule ? { abovePixelsPerBlock: zoomThreshold } : {}),
      ...(pitchRule ? { belowPitch: pitchThreshold * DEGREES } : {}),
    };
    onrules(zoomRule || pitchRule ? rules : undefined);
  });

  const projection = $derived(snapshot.projection);
  const scale = (pixels: number): string =>
    pixels >= 1 ? pixels.toFixed(pixels < 10 ? 2 : 1) : `1/${(1 / pixels).toFixed(1)}`;
</script>

<aside class="glass demo" aria-label="Projection demo">
  <h2>Projection demo</h2>
  <dl class="numeric">
    <dt>Chosen</dt>
    <dd>{projection.chosen}</dd>
    <dt>Shown</dt>
    <dd>{projection.shown} ({(projection.blend * 100).toFixed(0)}% ortho)</dd>
    <dt>Scale</dt>
    <dd>{scale(projection.pixelsPerBlock)} px/block</dd>
    <dt>Pitch</dt>
    <dd>{(snapshot.view.pitch / DEGREES).toFixed(1)}°</dd>
  </dl>

  <fieldset>
    <legend>Automatic perspective in isometric view</legend>
    <label>
      <input type="checkbox" bind:checked={zoomRule} />
      <span>Deep zoom, above</span>
      <input
        type="range"
        min="2"
        max="64"
        step="1"
        bind:value={zoomThreshold}
        disabled={!zoomRule}
        aria-label="Zoom threshold in pixels per block"
      />
      <output>{zoomThreshold} px/block</output>
    </label>
    <label>
      <input type="checkbox" bind:checked={pitchRule} />
      <span>Low tilt, below</span>
      <input
        type="range"
        min="5"
        max="45"
        step="1"
        bind:value={pitchThreshold}
        disabled={!pitchRule}
        aria-label="Pitch threshold in degrees"
      />
      <output>{pitchThreshold}°</output>
    </label>
  </fieldset>

  <div class="presets" role="group" aria-label="Scale presets, matching 2D map zoom levels">
    <span>px/block</span>
    {#each SCALES as pixels (pixels)}
      <button type="button" onclick={() => onscale(pixels)}>{scale(pixels)}</button>
    {/each}
  </div>
  <div class="presets" role="group" aria-label="Pitch presets">
    <span>Pitch</span>
    {#each PITCHES as degrees (degrees)}
      <button type="button" onclick={() => onpitch(degrees)}>{degrees}°</button>
    {/each}
  </div>
</aside>

<style>
  .demo {
    display: grid;
    gap: 8px;
    width: 300px;
    padding: 10px 12px;
    font-size: 12px;
  }

  h2 {
    margin: 0;
    font-size: 13px;
  }

  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    margin: 0;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    text-align: right;
  }

  fieldset {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
  }

  legend {
    color: var(--muted);
  }

  label {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: center;
    gap: 2px 6px;
  }

  label input[type="range"] {
    grid-column: 1 / 2;
    width: 150px;
  }

  output {
    text-align: right;
  }

  .presets {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
  }

  .presets span {
    color: var(--muted);
    margin-right: 2px;
  }

  .presets button {
    padding: 2px 6px;
    color: var(--text);
    background: #1b2532;
    border: 1px solid var(--panel-border);
    border-radius: 4px;
    font: inherit;
    cursor: pointer;
  }
</style>
