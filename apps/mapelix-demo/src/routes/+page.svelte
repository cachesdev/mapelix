<script lang="ts">
  import { onMount } from "svelte";
  import { replaceState } from "$app/navigation";
  import {
    MapelixViewer,
    TileIndex,
    type MapView,
    type PublishedTileManifest,
    type ViewState,
  } from "@mapelix/viewer";

  let { data }: { data: { world: boolean } } = $props();

  const NAMES: Record<string, string> = {
    overworld: "Overworld",
    nether: "Nether",
    "the-end": "End",
  };

  let container: HTMLDivElement;
  let viewer = $state.raw<MapelixViewer>();
  let view = $state.raw<ViewState>();
  let worldShown = $state(false);
  let worldFailed = $state(false);
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
      if (viewer === undefined) return;
      const current = viewer.view;
      const url = new URL(location.href);
      url.searchParams.set("dimension", current.dimension);
      url.searchParams.set("x", String(Math.round(current.x)));
      url.searchParams.set("z", String(Math.round(current.z)));
      url.searchParams.set("scale", String(Number(current.pixelsPerBlock.toPrecision(3))));
      url.searchParams.set("projection", current.projection);
      replaceState(url, {});
    }, 400);
  }

  onMount(() => {
    let disposed = false;
    // Safari ignores user-scalable=no; this stops its page pinch outside the map too.
    const prevent = (event: Event) => event.preventDefault();
    document.addEventListener("gesturestart", prevent);
    // A button pressed with a finger or the mouse hands the keys back to the view, so Space or
    // an arrow never presses it again. Keyboard presses (detail 0) keep the focus for Tab users.
    const release = (event: MouseEvent) => {
      // The path, not `target.closest`: the click may have swapped the icon it landed on.
      const button = event
        .composedPath()
        .find((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
      if (button === undefined || event.detail === 0) return;
      button.blur();
      viewer?.focus();
    };
    document.addEventListener("click", release);
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
        const projection = new URLSearchParams(location.search).get("projection");
        viewer = new MapelixViewer(container, {
          tiles: index,
          dimension: chosen,
          view: start.view,
          label: "World map",
          ...(data.world ? { world: { base: "/world" } } : {}),
          projection: projection === "perspective" ? "perspective" : "isometric",
          map: {
            onIdle: () =>
              Reflect.set(
                window,
                "__mapelixIdleAt",
                Reflect.get(window, "__mapelixIdleAt") ?? performance.now(),
              ),
          },
          onViewChange: (next) => {
            view = next;
            writeUrl();
          },
          onModeChange: (mode) => (worldShown = mode === "3d"),
          onWorldError: () => (worldFailed = true),
        });
        dimensions = index.dimensions;
        dimension = viewer.dimension;
        view = viewer.view;
        Reflect.set(window, "__mapelixViewer", viewer);
        Reflect.set(window, "__mapelixMap", viewer.map);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "The map could not be loaded";
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(urlTimer);
      document.removeEventListener("gesturestart", prevent);
      document.removeEventListener("click", release);
      viewer?.dispose();
    };
  });

  function choose(next: string): void {
    if (viewer === undefined || next === viewer.dimension) return;
    viewer.setDimension(next);
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

{#if viewer}
  <div class="corner bottom" role="group" aria-label="View">
    {#if data.world && !worldFailed}
      <!-- Hidden rather than removed in 2D, so the buttons below never move. -->
      <button
        class="round"
        class:hidden={!worldShown}
        aria-hidden={!worldShown}
        tabindex={worldShown ? 0 : -1}
        aria-pressed={view?.projection === "isometric"}
        aria-label="Isometric view"
        title={view?.projection === "isometric"
          ? "Switch to perspective view"
          : "Switch to isometric view"}
        onclick={() =>
          viewer?.setProjection(viewer.projection === "isometric" ? "perspective" : "isometric")}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          {#if view?.projection === "isometric"}
            <path d="m12 3 8 4.6v8.8L12 21l-8-4.6V7.6Zm-8 4.6 8 4.6 8-4.6M12 12.2V21" />
          {:else}
            <path d="M8 4h8l4.5 16h-17ZM3.5 20l8.5-6 8.5 6M12 14V4" />
          {/if}
        </svg>
      </button>
      <button
        class="round mode"
        aria-label={worldShown ? "Show the map" : "Show in 3D"}
        onclick={() => (worldShown ? viewer?.showMap() : viewer?.showWorld())}
        >{worldShown ? "2D" : "3D"}</button
      >
    {/if}
    <button class="round" aria-label="Zoom in" onclick={() => viewer?.zoomBy(2)}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
    </button>
    <button class="round" aria-label="Zoom out" onclick={() => viewer?.zoomBy(0.5)}>
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
  .map :global(:focus-visible) {
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
  .round.hidden {
    visibility: hidden;
  }
  .mode {
    font-weight: 700;
    letter-spacing: 0.02em;
  }
  .round:active {
    background: rgb(45 79 124 / 0.95);
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
