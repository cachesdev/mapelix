<script lang="ts">
  interface Props {
    /** Camera heading in radians clockwise from north. */
    heading: number;
    onnorth: () => void;
    onzoom: (factor: number) => void;
  }

  let { heading, onnorth, onzoom }: Props = $props();
</script>

<div class="glass controls">
  <button class="icon-button compass" type="button" onclick={onnorth} title="Face north">
    <svg viewBox="0 0 32 32" style:transform="rotate({-heading}rad)" aria-hidden="true">
      <path d="M16 4.5 20 16h-8z" fill="#f07a6a" />
      <path d="M16 27.5 12 16h8z" fill="currentColor" opacity="0.55" />
      <text x="16" y="3.6" text-anchor="middle">N</text>
    </svg>
    <span class="label">Face north</span>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button class="icon-button" type="button" onclick={() => onzoom(0.7)} title="Zoom in">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.6" />
    </svg>
    <span class="label">Zoom in</span>
  </button>
  <button class="icon-button" type="button" onclick={() => onzoom(1.4)} title="Zoom out">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h10" stroke="currentColor" stroke-width="1.6" />
    </svg>
    <span class="label">Zoom out</span>
  </button>
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
  }

  svg {
    width: 16px;
    height: 16px;
  }

  .compass svg {
    width: 28px;
    height: 28px;
    overflow: visible;
    transition: transform 80ms linear;
  }

  text {
    fill: var(--text);
    font-size: 6.5px;
    font-weight: 700;
  }

  .divider {
    width: 1px;
    height: 20px;
    margin: 0 2px;
    background: var(--panel-border);
  }

  .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
