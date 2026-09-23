<script lang="ts">
  import type { ViewerSnapshot } from "$lib/viewer/world-viewer";

  interface Props {
    snapshot: ViewerSnapshot;
  }

  let { snapshot }: Props = $props();

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

<aside class="glass debug numeric" aria-label="Rendering statistics">
  <dl>
    {#each rows as [name, value] (name)}
      <dt>{name}</dt>
      <dd>{value}</dd>
    {/each}
  </dl>
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
</style>
