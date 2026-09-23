<script lang="ts">
  interface Props {
    onjump: (x: number, z: number) => void;
    onhome: () => void;
  }

  let { onjump, onhome }: Props = $props();

  let x = $state<number>();
  let z = $state<number>();
  const ready = $derived(Number.isFinite(x) && Number.isFinite(z));

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (x !== undefined && z !== undefined && ready) onjump(x, z);
  }
</script>

<form class="glass jump" onsubmit={submit}>
  <label>
    <span>X</span>
    <input type="number" inputmode="numeric" placeholder="0" bind:value={x} />
  </label>
  <label>
    <span>Z</span>
    <input type="number" inputmode="numeric" placeholder="0" bind:value={z} />
  </label>
  <button class="icon-button" type="submit" disabled={!ready} title="Go to these coordinates">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" />
    </svg>
    <span class="label">Go to coordinates</span>
  </button>
  <span class="divider" aria-hidden="true"></span>
  <button class="icon-button" type="button" onclick={onhome} title="Return to spawn">
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3v-3h2v3h3V6.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linejoin="round"
      />
    </svg>
    <span class="label">Return to spawn</span>
  </button>
</form>

<style>
  .jump {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px;
  }

  label {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 8px 0 10px;
    border-radius: 9px;
    background: rgb(255 255 255 / 0.05);
  }

  label span {
    color: var(--faint);
    font-size: 12px;
    font-weight: 600;
  }

  input {
    width: 64px;
    border: 0;
    outline: none;
    background: transparent;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    appearance: textfield;
  }

  input::-webkit-inner-spin-button,
  input::-webkit-outer-spin-button {
    appearance: none;
    margin: 0;
  }

  input::placeholder {
    color: var(--faint);
  }

  button:disabled {
    color: var(--faint);
    cursor: default;
  }

  button:disabled:hover {
    background: transparent;
  }

  svg {
    width: 16px;
    height: 16px;
  }

  .label {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }

  .divider {
    width: 1px;
    height: 20px;
    background: var(--panel-border);
  }
</style>
