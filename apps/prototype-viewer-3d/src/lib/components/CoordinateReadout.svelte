<script lang="ts">
  interface Block {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  }

  interface Props {
    /** The block under the pointer, when there is one. */
    pointed: Block | undefined;
    /** The point the camera orbits, shown while the pointer is off the terrain. */
    focus: Block | undefined;
  }

  let { pointed, focus }: Props = $props();

  const shown = $derived(pointed ?? focus);
  const format = (value: number) => Math.round(value).toLocaleString("en-US").replace("-", "−");
</script>

<div
  class="glass readout numeric"
  title={pointed === undefined ? "View center" : "Block under the pointer"}
>
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {#if pointed === undefined}
      <circle cx="8" cy="8" r="2.2" fill="currentColor" />
      <circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.3" />
    {:else}
      <path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4" stroke="currentColor" stroke-width="1.4" />
    {/if}
  </svg>
  {#if shown === undefined}
    <span class="empty">No terrain</span>
  {:else}
    <span><b>X</b>{format(shown.x)}</span>
    <span><b>Y</b>{format(shown.y)}</span>
    <span><b>Z</b>{format(shown.z)}</span>
  {/if}
</div>

<style>
  .readout {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 236px;
    height: 40px;
    padding: 0 14px 0 12px;
    font-size: 13px;
  }

  svg {
    width: 16px;
    height: 16px;
    flex: none;
    color: var(--muted);
  }

  span {
    display: flex;
    gap: 6px;
    min-width: 48px;
  }

  b {
    color: var(--faint);
    font-weight: 600;
  }

  .empty {
    color: var(--muted);
  }
</style>
