<script lang="ts">
  interface Props {
    name: string | undefined;
    loading: number;
    failure: string | undefined;
  }

  let { name, loading, failure }: Props = $props();

  const status = $derived.by(() => {
    if (failure !== undefined) return failure;
    if (name === undefined) return "Opening world";
    if (loading === 0) return "All nearby terrain loaded";
    return `Loading ${loading} ${loading === 1 ? "region" : "regions"}`;
  });
</script>

<header class="glass card">
  <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
    <path fill="#6aa84f" d="M16 3 29 10.5 16 18 3 10.5z" />
    <path fill="#8a5f3f" d="M3 10.5 16 18v11L3 21.5z" />
    <path fill="#6b4830" d="M29 10.5 16 18v11l13-7.5z" />
  </svg>
  <div class="text">
    <h1>{name ?? "Mapelix"}</h1>
    <p class:busy={loading > 0} class:failed={failure !== undefined} aria-live="polite">
      <span class="dot" aria-hidden="true"></span>
      {status}
    </p>
  </div>
</header>

<style>
  .card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px 10px 12px;
  }

  .mark {
    width: 30px;
    height: 30px;
    flex: none;
  }

  .text {
    min-width: 0;
  }

  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 15px;
    font-weight: 620;
    letter-spacing: 0.005em;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  p {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
  }

  .busy .dot {
    background: var(--warning);
    box-shadow: 0 0 8px var(--warning);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .failed .dot {
    background: var(--danger);
    box-shadow: 0 0 8px var(--danger);
  }

  @keyframes pulse {
    50% {
      opacity: 0.35;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .busy .dot {
      animation: none;
    }
  }
</style>
