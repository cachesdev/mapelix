<script lang="ts">
  import { onMount } from "svelte";
  import { replaceState } from "$app/navigation";
  import {
    MapelixViewer,
    startFromSearch,
    TileIndex,
    viewerSearch,
    type PublishedTileManifest,
    type WorldSettings,
  } from "@mapelix/viewer";
  import { createViewerControls, type ViewerControls } from "@mapelix/viewer/controls";
  import { markerTexts, texts } from "$lib/texts";
  import { sampleMarkers } from "$lib/sample-markers";
  import { DemoMarkerStore } from "$lib/marker-store";

  let {
    data,
  }: {
    data: { world: boolean; texturePacks: boolean; markers: "spawn" | "examples"; worldId: string };
  } = $props();

  /** Preferences kept on this device; the address keeps the view itself. */
  const PREFERENCES = "mapelix-demo-preferences-v1";

  let container: HTMLDivElement;
  let error = $state<string>();
  let urlTimer = 0;

  function storedPreferences(): Partial<WorldSettings> {
    try {
      const stored = JSON.parse(localStorage.getItem(PREFERENCES) ?? "{}") as Record<
        string,
        unknown
      >;
      const result: Partial<{ -readonly [K in keyof WorldSettings]: WorldSettings[K] }> = {};
      if (typeof stored.clouds === "boolean") result.clouds = stored.clouds;
      if (
        stored.weather === "clear" ||
        stored.weather === "rain" ||
        stored.weather === "thunderstorm"
      )
        result.weather = stored.weather;
      if (typeof stored.autoDepth === "boolean") result.autoDepth = stored.autoDepth;
      if (typeof stored.showFps === "boolean") result.showFps = stored.showFps;
      if (stored.blockLight !== null && typeof stored.blockLight === "object") {
        const modes = stored.blockLight as Record<string, unknown>;
        result.blockLight = Object.fromEntries(
          ["overworld", "nether", "the-end"].flatMap(dimension =>
            typeof modes[dimension] === "boolean" ? [[dimension, modes[dimension]]] : [],
          ),
        );
      }
      return result;
    } catch {
      return {};
    }
  }

  /** The world spawn, from the 3D world description. */
  async function worldSpawn(): Promise<{ x: number; z: number } | undefined> {
    try {
      const response = await fetch("/world/world.json");
      if (!response.ok) return undefined;
      const spawn = ((await response.json()) as { spawn?: { x?: unknown; z?: unknown } }).spawn;
      return typeof spawn?.x === "number" && typeof spawn.z === "number"
        ? { x: spawn.x, z: spawn.z }
        : undefined;
    } catch {
      return undefined;
    }
  }

  onMount(() => {
    let viewer: MapelixViewer | undefined;
    let controls: ViewerControls | undefined;
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
        const start = startFromSearch(new URLSearchParams(location.search));
        const dimension =
          start.dimension !== undefined && index.dimensions.includes(start.dimension)
            ? start.dimension
            : index.dimensions.includes("overworld")
              ? "overworld"
              : index.dimensions[0];
        viewer = new MapelixViewer(container, {
          tiles: index,
          dimension,
          view: start.view,
          projection: start.projection,
          settings: { ...storedPreferences(), ...start.settings },
          label: "World map",
          markerTexts,
          ...(data.world ? { world: { base: "/world" } } : {}),
          map: {
            onIdle: () =>
              Reflect.set(
                window,
                "__mapelixIdleAt",
                Reflect.get(window, "__mapelixIdleAt") ?? performance.now(),
              ),
          },
        });
        // Markers are edited in place and kept in this browser; `?readonly=1` shows a public,
        // read-only map.
        const store = new DemoMarkerStore(data.worldId);
        const readOnly = new URLSearchParams(location.search).get("readonly") === "1";
        controls = createViewerControls(viewer, container, {
          texts,
          markers: store.editor(readOnly),
          ...(data.texturePacks
            ? { texturesLink: { href: "/textures", label: "Choose the texture packs" } }
            : {}),
        });
        // Example markers (or the spawn alone) around the world spawn, else the start view.
        const shown = viewer;
        const origin = { x: shown.view.x, z: shown.view.z };
        void (data.world ? worldSpawn() : Promise.resolve(undefined)).then((spawn) => {
          if (!disposed) shown.markers.set(store.load(sampleMarkers(spawn ?? origin, data.markers === "spawn")));
        });
        Reflect.set(window, "__mapelixMarkerStore", store);
        let lastPreferences = "";
        viewer.subscribe((_view, status, settings) => {
          clearTimeout(urlTimer);
          urlTimer = window.setTimeout(() => {
            if (viewer !== undefined)
              replaceState(`?${viewerSearch(viewer)}${readOnly ? "&readonly=1" : ""}`, {});
          }, 400);
          const preferences = JSON.stringify({
            clouds: settings.clouds,
            weather: settings.weather,
            autoDepth: settings.autoDepth,
            showFps: settings.showFps,
            blockLight: settings.blockLight,
          });
          if (preferences !== lastPreferences) {
            lastPreferences = preferences;
            try {
              localStorage.setItem(PREFERENCES, preferences);
            } catch {
              /* Preferences are optional. */
            }
          }
          if (status.name) document.title = status.name;
        });
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
      controls?.dispose();
      viewer?.dispose();
    };
  });
</script>

<svelte:head>
  <title>Mapelix map</title>
  <link rel="preload" href="/tiles/manifest.json" as="fetch" crossorigin="anonymous" />
</svelte:head>

<div class="map" bind:this={container}></div>

{#if error}
  <p class="notice" role="alert">{error}</p>
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
