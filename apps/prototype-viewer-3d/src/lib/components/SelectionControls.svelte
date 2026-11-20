<script lang="ts">
  import {
    horizontalSelection,
    type HorizontalSelection,
  } from "@mapelix/scene-prototype/selection";
  import type { SelectionTool } from "@mapelix/viewer/three/selection-box";
  interface Props {
    selection: HorizontalSelection | undefined;
    tool: SelectionTool;
    onselect: () => void;
    onchange: (selection: HorizontalSelection | undefined) => void;
    ontool: (tool: SelectionTool) => void;
  }
  let { selection, tool, onselect, onchange, ontool }: Props = $props();
  let minX = $state(0),
    maxX = $state(64),
    minZ = $state(0),
    maxZ = $state(64);
  let error = $state("");
  $effect(() => {
    if (selection) {
      minX = selection.minX;
      maxX = selection.maxX;
      minZ = selection.minZ;
      maxZ = selection.maxZ;
    }
  });
  function apply(event: SubmitEvent) {
    event.preventDefault();
    try {
      onchange(horizontalSelection({ minX, maxX, minZ, maxZ }));
      error = "";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
</script>

<details class="glass area">
  <summary>Exploration area {selection ? "· selected" : "· all nearby"}</summary>
  <p>Focus on the underground beneath one location.</p>
  <button onclick={onselect}>Select around view</button>
  {#if selection}
    <button onclick={() => onchange(undefined)}>Clear area</button>
    <form onsubmit={apply}>
      <label>Min X <input type="number" step="1" bind:value={minX} required /></label>
      <label>Max X (exclusive) <input type="number" step="1" bind:value={maxX} required /></label>
      <label>Min Z <input type="number" step="1" bind:value={minZ} required /></label>
      <label>Max Z (exclusive) <input type="number" step="1" bind:value={maxZ} required /></label>
      <button type="submit">Apply area</button>
    </form>
    <label for="selection-tool">3D box</label>
    <select
      id="selection-tool"
      value={tool}
      onchange={(event) => ontool(event.currentTarget.value as SelectionTool)}
    >
      <option value="off">View only</option>
      <option value="move">Move</option>
      <option value="resize">Resize</option>
    </select>
    <p>
      Drag the colored handles. Resize changes width and depth; move Y changes the slice when
      released.
    </p>
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
</details>

<style>
  .area {
    padding: 10px 12px;
    width: 320px;
    max-width: calc(100vw - 24px);
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  p {
    color: var(--muted);
    line-height: 1.4;
  }
  form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin: 10px 0;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  input {
    width: 100%;
    box-sizing: border-box;
  }
  button,
  input,
  select {
    color: var(--text);
    background: #1b2532;
    border: 1px solid #586473;
    border-radius: 5px;
    padding: 5px 8px;
  }
  button {
    cursor: pointer;
  }
</style>
