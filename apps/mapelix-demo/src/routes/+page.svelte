<script lang="ts">
  import { onMount } from "svelte";
  import { replaceState } from "$app/navigation";
  import { TileIndex, TileMap, type MapView, type PublishedTileManifest } from "@mapelix/viewer";

  const NAMES: Record<string, string> = {
    overworld: "Overworld",
    nether: "Nether",
    "the-end": "End",
  };

  let container: HTMLDivElement;
  let map = $state<TileMap>();
  let view = $state<MapView>();
  let dimensions = $state<string[]>([]);
  let dimension = $state("");
  let error = $state<string>();
  let panelOpen = $state(false);
  let urlTimer = 0;

  /** Initial view from the address bar: `?x=&z=&scale=&dimension=`. */
  function viewFromUrl(): { view: Partial<MapView>; dimension?: string } {
    const params = new URLSearchParams(location.search);
    const number = (name: string) => {
      const raw = params.get(name);
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const result: Partial<{ -readonly [K in keyof MapView]: MapView[K] }> = {};
    const x = number("x"),
      z = number("z"),
      scale = number("scale");
    if (x !== undefined) result.x = x;
    if (z !== undefined) result.z = z;
    if (scale !== undefined && scale > 0) result.pixelsPerBlock = scale;
    return { view: result, dimension: params.get("dimension") ?? undefined };
  }

  function writeUrl(): void {
    clearTimeout(urlTimer);
    urlTimer = window.setTimeout(() => {
      if (map === undefined) return;
      const url = new URL(location.href);
      url.searchParams.set("dimension", map.dimension);
      url.searchParams.set("x", String(Math.round(map.view.x)));
      url.searchParams.set("z", String(Math.round(map.view.z)));
      url.searchParams.set("scale", String(Number(map.view.pixelsPerBlock.toPrecision(3))));
      replaceState(url, {});
    }, 400);
  }

  onMount(() => {
    let disposed = false;
    // Safari ignores user-scalable=no; this stops its page pinch outside the map too.
    const prevent = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", prevent);
    void (async () => {
      try {
        const url = new URL("/tiles/manifest.json", location.href);
        // Preloaded from the page head, alongside the code.
        const response = await fetch(url);
        if (!response.ok) throw new Error(`The map could not be loaded (${response.status})`);
        const index = new TileIndex((await response.json()) as PublishedTileManifest, url);
        if (disposed) return;
        const start = viewFromUrl();
        const chosen =
          start.dimension !== undefined && index.dimensions.includes(start.dimension)
            ? start.dimension
            : index.dimensions.includes("overworld")
              ? "overworld"
              : index.dimensions[0];
        map = new TileMap(container, {
          index,
          dimension: chosen,
          view: start.view,
          label: "World map",
          onIdle: () =>
            Reflect.set(
              window,
              "__mapelixIdleAt",
              Reflect.get(window, "__mapelixIdleAt") ?? performance.now(),
            ),
          onViewChange: (next) => {
            view = next;
            writeUrl();
          },
        });
        dimensions = index.dimensions;
        dimension = map.dimension;
        view = map.view;
        Reflect.set(window, "__mapelixMap", map);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "The map could not be loaded";
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(urlTimer);
      document.removeEventListener("gesturestart", prevent);
      map?.dispose();
    };
  });

  function choose(next: string): void {
    if (map === undefined || next === map.dimension) return;
    map.setDimension(next);
    dimension = next;
  }

  const scaleLabel = $derived(
    view === undefined
      ? ""
      : view.pixelsPerBlock >= 1
        ? `${Number(view.pixelsPerBlock.toPrecision(2))} px/block`
        : `1 px = ${Number((1 / view.pixelsPerBlock).toPrecision(2))} blocks`,
  );
</script>

<svelte:head>
  <title>Mapelix map</title>
  <link rel="preload" href="/tiles/manifest.json" as="fetch" crossorigin="anonymous" />
</svelte:head>

<div class="map" bind:this={container}></div>

{#if error}
  <p class="notice" role="alert">{error}</p>
{/if}

{#if view}
  <p class="readout" aria-live="off">
    <span>X {Math.round(view.x)}</span>
    <span>Z {Math.round(view.z)}</span>
    <span class="scale">{scaleLabel}</span>
  </p>
{/if}

<div class="corner top">
  {#if dimensions.length > 1}
    <button
      class="round"
      aria-expanded={panelOpen}
      aria-controls="layers"
      aria-label="Dimensions"
      onclick={() => (panelOpen = !panelOpen)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"
        ><path d="M12 3 2 8l10 5 10-5-10-5Zm-8 9 8 4 8-4M4 16l8 4 8-4" /></svg
      >
    </button>
    {#if panelOpen}
      <div class="panel" id="layers" role="group" aria-label="Dimensions">
        {#each dimensions as name (name)}
          <button
            class="choice"
            aria-pressed={name === dimension}
            onclick={() => {
              choose(name);
              panelOpen = false;
            }}>{NAMES[name] ?? name}</button
          >
        {/each}
      </div>
    {/if}
  {/if}
</div>

{#if map}
  <div class="corner bottom" role="group" aria-label="Zoom">
    <button class="round" aria-label="Zoom in" onclick={() => map?.zoomBy(2)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
    <button class="round" aria-label="Zoom out" onclick={() => map?.zoomBy(0.5)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
    </button>
  </div>
{/if}

<style>
  :global(html),
  :global(body) {
    margin: 0;
    height: 100%;
    overflow: hidden;
    overscroll-behavior: none;
    background: #1b1d22;
    color: #eef0f3;
    font:
      15px/1.3 system-ui,
      sans-serif;
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
  }
  .map {
    position: fixed;
    inset: 0;
    height: 100dvh;
  }
  .map:focus-visible {
    outline: 2px solid #7fb4ff;
    outline-offset: -2px;
  }
  .readout {
    position: fixed;
    left: calc(8px + env(safe-area-inset-left));
    bottom: calc(8px + env(safe-area-inset-bottom));
    margin: 0;
    padding: 6px 10px;
    border-radius: 8px;
    background: rgb(20 22 26 / 0.78);
    display: flex;
    gap: 10px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    max-width: calc(100vw - 96px - env(safe-area-inset-left) - env(safe-area-inset-right));
    white-space: nowrap;
    overflow: hidden;
  }
  .scale {
    opacity: 0.75;
  }
  .corner {
    position: fixed;
    right: calc(8px + env(safe-area-inset-right));
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .top {
    top: calc(8px + env(safe-area-inset-top));
  }
  .bottom {
    bottom: calc(8px + env(safe-area-inset-bottom));
  }
  button {
    font: inherit;
    color: inherit;
    border: 0;
    cursor: pointer;
    touch-action: manipulation;
  }
  .round {
    width: 48px;
    height: 48px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    background: rgb(20 22 26 / 0.85);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  }
  .round:focus-visible,
  .choice:focus-visible {
    outline: 2px solid #7fb4ff;
  }
  svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .panel {
    display: flex;
    flex-direction: column;
    padding: 4px;
    border-radius: 12px;
    background: rgb(20 22 26 / 0.92);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
  }
  .choice {
    min-height: 44px;
    min-width: 140px;
    padding: 0 14px;
    border-radius: 8px;
    background: transparent;
    text-align: left;
  }
  .choice[aria-pressed="true"] {
    background: #2d4f7c;
  }
  .notice {
    position: fixed;
    inset: auto 16px 50% 16px;
    margin: 0;
    padding: 12px 16px;
    border-radius: 10px;
    background: #4a2026;
    text-align: center;
  }
</style>
