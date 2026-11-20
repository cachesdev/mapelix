<script lang="ts">
  import { onDestroy } from "svelte";
  import type { VerticalMovement } from "@mapelix/viewer/three/camera-rig";
  import type { DepthNavigation } from "@mapelix/viewer/three/depth-follow";

  interface Props {
    navigation: DepthNavigation;
    autoDepth: boolean;
    onauto: (enabled: boolean) => void;
    onmove: (direction: VerticalMovement) => void;
    onrecover: () => void;
  }

  let { navigation, autoDepth, onauto, onmove, onrecover }: Props = $props();
  let pointer: number | undefined;
  let nudge: ReturnType<typeof setTimeout> | undefined;

  function stop(): void {
    pointer = undefined;
    clearTimeout(nudge);
    onmove(0);
  }

  function press(event: PointerEvent, direction: VerticalMovement): void {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    stop();
    pointer = event.pointerId;
    event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(pointer);
    onmove(direction);
  }

  function release(event: PointerEvent): void {
    if (pointer === event.pointerId) stop();
  }

  function key(event: KeyboardEvent, direction: VerticalMovement): void {
    if (event.code !== "Space" && event.code !== "Enter") return;
    event.preventDefault();
    onmove(direction);
  }

  function click(event: MouseEvent, direction: VerticalMovement): void {
    // Assistive activation may provide a click without pointer or keyboard events.
    if (event.detail !== 0) return;
    stop();
    onmove(direction);
    nudge = setTimeout(stop, 150);
  }

  onDestroy(stop);
</script>

<svelte:window onblur={stop} />
<svelte:document
  onvisibilitychange={() => {
    if (document.hidden) stop();
  }}
/>

<div class="glass navigation" aria-label="Cave navigation">
  <div class="buttons">
    <button
      type="button"
      title="Descend (C)"
      onpointerdown={(event) => press(event, -1)}
      onpointerup={release}
      onpointercancel={release}
      onlostpointercapture={release}
      onkeydown={(event) => key(event, -1)}
      onkeyup={(event) => key(event, 0)}
      onblur={stop}
      onclick={(event) => click(event, -1)}>↓ <span>Descend</span></button
    >
    <button
      type="button"
      title="Ascend (Space)"
      onpointerdown={(event) => press(event, 1)}
      onpointerup={release}
      onpointercancel={release}
      onlostpointercapture={release}
      onkeydown={(event) => key(event, 1)}
      onkeyup={(event) => key(event, 0)}
      onblur={stop}
      onclick={(event) => click(event, 1)}>↑ <span>Ascend</span></button
    >
    <button
      type="button"
      title="Return above the current slice"
      onclick={() => {
        stop();
        onrecover();
      }}>Recover view</button
    >
  </div>
  <label
    ><input
      type="checkbox"
      checked={autoDepth}
      disabled={!navigation.available}
      onchange={(event) => onauto(event.currentTarget.checked)}
    /> Follow depth automatically</label
  >
  <p role="status">
    {navigation.loading ? "Opening next depth…" : "Space ↑ / C ↓, or hold the buttons"}
  </p>
  {#if navigation.error}<p class="error" role="status">{navigation.error}</p>{/if}
</div>

<style>
  .navigation {
    padding: 8px;
    font-size: 12px;
    max-width: 320px;
  }
  .buttons {
    display: flex;
    gap: 4px;
  }
  button {
    min-width: 44px;
    min-height: 44px;
    border: 1px solid var(--panel-border);
    border-radius: 6px;
    background: #1b2532;
    color: var(--text);
    cursor: pointer;
    padding: 6px 8px;
    touch-action: none;
    user-select: none;
  }
  button:focus-visible {
    outline: 2px solid #8fc8ff;
    outline-offset: 2px;
  }
  label {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-top: 8px;
  }
  p {
    color: var(--muted);
    margin: 6px 0 0;
    font-size: 11px;
  }
  .error {
    color: #ffb5a5;
  }
</style>
