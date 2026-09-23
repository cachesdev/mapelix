<script lang="ts">
  interface Props {
    /** Hour from 0 to 24. */
    hour: number;
  }

  let { hour = $bindable() }: Props = $props();

  const clock = $derived.by(() => {
    const minutes = Math.round((hour * 60) / 15) * 15;
    const hours = Math.floor(minutes / 60) % 24;
    return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  });
  const daytime = $derived(hour >= 6 && hour <= 18);
</script>

<label class="glass time">
  <svg viewBox="0 0 16 16" aria-hidden="true">
    {#if daytime}
      <circle cx="8" cy="8" r="3" fill="currentColor" />
      <path
        d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M3.4 12.6l1.3-1.3M11.3 4.7l1.3-1.3"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    {:else}
      <path d="M11.8 10.4A5 5 0 0 1 5.6 4.2a5 5 0 1 0 6.2 6.2z" fill="currentColor" />
    {/if}
  </svg>
  <span class="visually-hidden">Time of day</span>
  <input type="range" min="0" max="24" step="0.25" bind:value={hour} />
  <output class="numeric">{clock}</output>
</label>

<style>
  .time {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 40px;
    padding: 0 14px;
  }

  svg {
    width: 16px;
    height: 16px;
    flex: none;
    color: #ffd48a;
  }

  input {
    width: 180px;
    accent-color: var(--accent);
    cursor: pointer;
  }

  output {
    width: 40px;
    color: var(--muted);
    font-size: 13px;
    text-align: right;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
  }
</style>
