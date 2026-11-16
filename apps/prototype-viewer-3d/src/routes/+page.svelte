<script lang="ts">
  import type { Attachment } from "svelte/attachments";
  import {
    DIMENSIONS,
    CAVE_LIMITS,
    contextKey,
    contextSearch,
    parseDimension,
    sceneContext,
    type Dimension,
    type SceneContext,
    type ViewMode,
  } from "@mapelix/scene-prototype/dimensions";

  import CoordinateReadout from "$lib/components/CoordinateReadout.svelte";
  import DebugPanel from "$lib/components/DebugPanel.svelte";
  import JumpForm from "$lib/components/JumpForm.svelte";
  import StatusCard from "$lib/components/StatusCard.svelte";
  import TimeOfDay from "$lib/components/TimeOfDay.svelte";
  import ViewControls from "$lib/components/ViewControls.svelte";
  import ProjectionDemo from "$lib/components/ProjectionDemo.svelte";
  import CaveNavigation from "$lib/components/CaveNavigation.svelte";
  import SelectionControls from "$lib/components/SelectionControls.svelte";
  import DiscoveryControls from "$lib/components/DiscoveryControls.svelte";
  import {
    DEFAULT_DISCOVERY_FILTERS,
    discoveryFilters,
    type DiscoveryFilters,
    type DiscoveryGroup,
  } from "@mapelix/scene-prototype/discoveries";
  import { selectionAround, type HorizontalSelection } from "@mapelix/scene-prototype/selection";
  import type { SelectionTool } from "$lib/viewer/selection-box";
  import { readViewFromUrl, writeViewToUrl } from "$lib/view-url";
  import type {
    Pointed,
    ViewerSnapshot,
    WorldInfo,
    WorldViewer,
    WeatherMode,
    ViewProjection,
  } from "$lib/viewer/world-viewer";

  const DEFAULT_HOUR = 15.5;

  let world = $state.raw<WorldInfo>();
  let viewer = $state.raw<WorldViewer>();
  let snapshot = $state.raw<ViewerSnapshot>();
  let pointed = $state.raw<Pointed>();
  let failure = $state<string>();
  let hour = $state(DEFAULT_HOUR);
  let debugVisible = $state(false);
  let edgeFade = $state(true);
  let clouds = $state(true);
  let weather = $state<WeatherMode>("clear");
  let customRenderDistance = $state(false);
  let renderDistance = $state(32_000);
  let zoomUnlocked = $state(false);
  let hintVisible = $state(true);
  let dimension = $state<Dimension>("overworld");
  let ceilingY = $state(96);
  let mode = $state<ViewMode>("surface");
  let sliceMinY = $state(-64);
  let sliceThickness = $state(32);
  let selectedArea = $state.raw<HorizontalSelection>();
  let selectionTool = $state<SelectionTool>("off");
  let discoveryPrefs = $state.raw<DiscoveryFilters>(DEFAULT_DISCOVERY_FILTERS);
  let autoDepth = $state(true);
  let projection = $state<ViewProjection>("perspective");
  /** `?demo=projection` shows controls for automatic perspective rules. */
  let projectionDemo = $state(false);
  const surfaceCeilings = new Map<Dimension, number>();
  let switching = $state(false);
  let loadContext: ((context: SceneContext) => Promise<void>) | undefined;

  $effect(() => {
    viewer?.setTimeOfDay(hour);
  });

  $effect(() => {
    viewer?.setEdgeFade(edgeFade);
  });

  $effect(() => {
    if (!viewer) return;
    viewer.setClouds(clouds);
    try {
      localStorage.setItem("mapelix-clouds-v1", clouds ? "1" : "0");
    } catch {
      /* Visual preferences are optional. */
    }
  });

  $effect(() => {
    viewer?.setRenderDistance(customRenderDistance ? renderDistance : undefined);
  });

  $effect(() => {
    if (!viewer) return;
    viewer.setWeather(weather);
    try {
      localStorage.setItem("mapelix-weather-v1", weather);
    } catch {
      /* Visual preferences are optional. */
    }
  });

  $effect(() => {
    viewer?.setZoomUnlocked(zoomUnlocked);
  });
  $effect(() => {
    viewer?.setSelectionTool(selectionTool);
  });
  $effect(() => {
    if (!viewer) return;
    viewer.setAutoDepth(autoDepth);
    try {
      localStorage.setItem("mapelix-auto-depth-v1", autoDepth ? "1" : "0");
    } catch {
      /* Browser storage is optional. */
    }
  });
  $effect(() => {
    if (!viewer) return;
    viewer.setDiscoveryFilters(discoveryPrefs);
    try {
      localStorage.setItem("mapelix-discoveries-v1", JSON.stringify(discoveryPrefs));
    } catch {
      /* Preferences are optional when browser storage is unavailable. */
    }
  });

  const attachViewer: Attachment<HTMLDivElement> = (element) => {
    let disposed = false;
    let created: WorldViewer | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    let lastUrl = "";
    let start;
    try {
      start = readViewFromUrl(new URL(window.location.href));
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    dimension = start.context.dimension;
    projection = start.projection ?? "perspective";
    projectionDemo = new URL(window.location.href).searchParams.get("demo") === "projection";
    try {
      clouds = localStorage.getItem("mapelix-clouds-v1") !== "0";
    } catch {
      clouds = true;
    }
    try {
      const stored = localStorage.getItem("mapelix-weather-v1");
      weather = stored === "rain" || stored === "thunderstorm" ? stored : "clear";
    } catch {
      weather = "clear";
    }
    ceilingY = start.context.ceilingY;
    mode = start.context.mode;
    sliceMinY = start.context.minY;
    if (start.context.mode === "caves") sliceThickness = start.context.maxY - start.context.minY;
    hour = start.hour ?? DEFAULT_HOUR;
    selectedArea = start.selection;
    let initialAutoDepth = start.autoDepth;
    if (initialAutoDepth === undefined) {
      try {
        initialAutoDepth = localStorage.getItem("mapelix-auto-depth-v1") !== "0";
      } catch {
        initialAutoDepth = true;
      }
    }
    autoDepth = initialAutoDepth;
    let initialDiscoveries = start.discoveries;
    if (!initialDiscoveries) {
      try {
        const stored = localStorage.getItem("mapelix-discoveries-v1");
        if (stored) initialDiscoveries = discoveryFilters(JSON.parse(stored));
      } catch {
        /* Ignore invalid saved preferences. */
      }
    }
    initialDiscoveries ??= DEFAULT_DISCOVERY_FILTERS;
    discoveryPrefs = initialDiscoveries;
    let metadataRequest = new AbortController();
    let generation = 0;

    loadContext = async (context) => {
      const current = ++generation;
      metadataRequest.abort();
      metadataRequest = new AbortController();
      created?.setAutoDepth(false);
      switching = true;
      failure = undefined;
      try {
        const response = await fetch(`/world.json?${contextSearch(context)}`, {
          signal: metadataRequest.signal,
        });
        if (!response.ok) throw new Error(`The dimension could not be opened (${response.status})`);
        const info: WorldInfo = await response.json();
        if (disposed || current !== generation) return;
        created?.setWorld(info, world?.dimension === info.dimension);
        selectedArea = created?.snapshot().selection;
        world = info;
        updateContext(info);
        pointed = undefined;
        snapshot = created?.snapshot();
      } catch (cause) {
        if (disposed || current !== generation) return;
        failure = cause instanceof Error ? cause.message : String(cause);
        if (world) {
          updateContext(world);
        }
      } finally {
        if (current === generation) {
          switching = false;
          created?.setAutoDepth(autoDepth);
        }
      }
    };

    void (async () => {
      const [{ WorldViewer }, response] = await Promise.all([
        import("$lib/viewer/world-viewer"),
        fetch(`/world.json?${contextSearch(start.context)}`, { signal: metadataRequest.signal }),
      ]);
      if (!response.ok) throw new Error(`The world could not be opened (${response.status})`);
      const info: WorldInfo = await response.json();
      if (disposed) return;
      world = info;
      updateContext(info);
      created = await WorldViewer.create(element, info, start.view, {
        clouds,
        projection,
        weather,
        ...(start.selection ? { selection: start.selection } : {}),
        discoveryFilters: initialDiscoveries,
        autoDepth: initialAutoDepth,
        loadDepth: async (context, signal) => {
          const response = await fetch(`/world.json?${contextSearch(context)}`, { signal });
          if (!response.ok) throw new Error(`The depth could not be opened (${response.status})`);
          return (await response.json()) as WorldInfo;
        },
        onDiscoverySelect: (group) => {
          void exploreDiscovery(group);
        },
        onSelectionChange: (change) => {
          selectedArea = change.selection;
          if (change.minY !== sliceMinY) {
            sliceMinY = change.minY;
            changeSlice();
          }
        },
      });
      if (disposed) {
        created.dispose();
        return;
      }
      viewer = created;
      polling = setInterval(() => {
        snapshot = created?.snapshot();
        if (snapshot === undefined) return;
        if (!switching && world && contextKey(world) !== contextKey(snapshot.context)) {
          world = { ...world, ...snapshot.context };
          updateContext(world);
          pointed = undefined;
        }
        const key = JSON.stringify([
          snapshot.view,
          hour,
          world && contextKey(world),
          snapshot.selection,
          discoveryPrefs,
          autoDepth,
          projection,
        ]);
        if (key !== lastUrl && world)
          writeViewToUrl(
            snapshot.view,
            hour,
            world,
            snapshot.selection,
            discoveryPrefs,
            autoDepth,
            projection,
          );
        lastUrl = key;
      }, 250);
    })().catch((cause: unknown) => {
      if (disposed) return;
      failure = cause instanceof Error ? cause.message : String(cause);
    });

    // Picking marches a ray over height maps, so it runs at most once per frame.
    let pending: PointerEvent | undefined;
    const onPointerMove = (event: PointerEvent): void => {
      if (pending === undefined) {
        requestAnimationFrame(() => {
          if (pending !== undefined) pointed = created?.pick(pending.clientX, pending.clientY);
          pending = undefined;
        });
      }
      pending = event;
    };
    const onPointerLeave = (): void => {
      pointed = undefined;
    };
    const dismissHint = (): void => {
      hintVisible = false;
    };
    const hintTimer = setTimeout(dismissHint, 9000);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointerdown", dismissHint, { once: true });
    element.addEventListener("wheel", dismissHint, { once: true, passive: true });

    return () => {
      disposed = true;
      metadataRequest.abort();
      loadContext = undefined;
      clearInterval(polling);
      clearTimeout(hintTimer);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      created?.dispose();
      viewer = undefined;
    };
  };

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "F3") {
      event.preventDefault();
      debugVisible = !debugVisible;
    }
  }

  function returnToSpawn(): void {
    if (world !== undefined) viewer?.flyTo(world.spawn.x, world.spawn.z);
  }

  function updateContext(info: WorldInfo): void {
    const context = sceneContext(info.dimension, info);
    dimension = context.dimension;
    mode = context.mode;
    ceilingY = context.maxY;
    if (mode === "caves") {
      sliceMinY = context.minY;
      sliceThickness = context.maxY - context.minY;
    } else surfaceCeilings.set(dimension, context.maxY);
  }

  function changeMode(value: string): void {
    if (value === "surface") {
      void loadContext?.(sceneContext(dimension, surfaceCeilings.get(dimension)));
    } else changeSlice();
  }

  function changeSlice(): void {
    const config = DIMENSIONS[dimension];
    sliceMinY = Math.max(config.minY, Math.min(sliceMinY, config.maxY - sliceThickness));
    void loadContext?.(
      sceneContext(dimension, { mode: "caves", minY: sliceMinY, maxY: sliceMinY + sliceThickness }),
    );
  }

  function applyArea(area: HorizontalSelection | undefined): void {
    selectedArea = area;
    viewer?.setSelection(area);
  }

  async function exploreDiscovery(group: DiscoveryGroup): Promise<void> {
    if (!viewer || group.dimension !== dimension) return;
    if (await viewer.focusDiscovery(group)) {
      snapshot = viewer.snapshot();
      if (world) {
        world = { ...world, ...snapshot.context };
        updateContext(world);
      }
      selectedArea = snapshot.selection;
    }
  }
</script>

<svelte:head>
  <title>{world?.name ?? "Mapelix"}</title>
  <meta name="description" content="Explore a Minecraft Bedrock world in 3D." />
</svelte:head>

<svelte:window onkeydown={onKeyDown} />

<main>
  <div
    class="scene"
    {@attach attachViewer}
    aria-label="3D view of the world"
    role="application"
  ></div>

  <div class="overlay" class:caves={mode === "caves"}>
    <div class="top-left">
      <StatusCard name={world?.name} loading={snapshot?.streaming.remaining ?? 0} {failure} />
      {#if mode === "caves" && snapshot && snapshot.streaming.cached > 0 && snapshot.streaming.remaining === 0 && snapshot.streaming.quads === 0}
        <p class="glass cave-hint">No cave surfaces here. Change depth or move to another area.</p>
      {/if}
      {#if debugVisible && snapshot !== undefined}
        <DebugPanel
          {snapshot}
          bind:edgeFade
          bind:customRenderDistance
          bind:renderDistance
          bind:zoomUnlocked
        />
      {/if}
      {#if projectionDemo && viewer && snapshot}
        <ProjectionDemo
          {snapshot}
          onrules={(rules) => viewer?.setAutoPerspective(rules)}
          onscale={(pixels) => viewer?.setPixelsPerBlock(pixels)}
          onpitch={(degrees) => viewer?.setPitch((degrees * Math.PI) / 180)}
        />
      {/if}
    </div>

    <div class="top-right">
      <div class="glass dimensions">
        <label for="dimension">Dimension</label>
        <select
          id="dimension"
          value={dimension}
          disabled={!viewer || switching}
          onchange={(event) =>
            void loadContext?.(sceneContext(parseDimension(event.currentTarget.value)))}
        >
          {#each Object.values(DIMENSIONS) as config}
            <option value={config.dimension}>{config.label}</option>
          {/each}
        </select>
        <label for="view-mode">View</label>
        <select
          id="view-mode"
          value={mode}
          disabled={!viewer || switching}
          onchange={(event) => changeMode(event.currentTarget.value)}
        >
          <option value="surface">Surface</option>
          <option value="caves">Caves</option>
        </select>
        {#if mode === "surface" && dimension === "overworld"}
          <label><input type="checkbox" bind:checked={clouds} /> Clouds</label>
          <label
            ><input
              type="checkbox"
              checked={weather !== "clear"}
              onchange={(event) => {
                weather = event.currentTarget.checked ? "rain" : "clear";
              }}
            /> Rain</label
          >
          <label
            ><input
              type="checkbox"
              checked={weather === "thunderstorm"}
              disabled={weather === "clear"}
              onchange={(event) => {
                weather = event.currentTarget.checked ? "thunderstorm" : "rain";
              }}
            /> Thunderstorm</label
          >
        {/if}
        {#if mode === "caves"}
          <label for="cave-thickness">Slice thickness</label>
          <select
            id="cave-thickness"
            bind:value={sliceThickness}
            disabled={switching}
            onchange={changeSlice}
          >
            {#each CAVE_LIMITS.thicknesses as thickness}
              <option value={thickness}>{thickness} blocks</option>
            {/each}
          </select>
          <label for="cave-min-y">Slice: Y {sliceMinY} to {sliceMinY + sliceThickness - 1}</label>
          <input
            id="cave-min-y"
            type="range"
            min={DIMENSIONS[dimension].minY}
            max={DIMENSIONS[dimension].maxY - sliceThickness}
            step="16"
            bind:value={sliceMinY}
            disabled={switching}
            onchange={changeSlice}
          />
        {:else if dimension === "nether"}
          <label for="ceiling">Hide terrain from Y {ceilingY}</label>
          <input
            id="ceiling"
            type="range"
            min="16"
            max="128"
            step="16"
            bind:value={ceilingY}
            disabled={switching}
            onchange={() => void loadContext?.(sceneContext(dimension, ceilingY))}
          />
        {/if}
      </div>
      {#if mode === "caves" && viewer}
        <SelectionControls
          selection={selectedArea}
          tool={selectionTool}
          onselect={() => {
            const v = viewer?.snapshot().view;
            if (v) applyArea(selectionAround(v.x, v.z));
          }}
          onchange={applyArea}
          ontool={(tool) => {
            selectionTool = tool;
          }}
        />
      {/if}
      {#if viewer && snapshot}
        <DiscoveryControls
          filters={discoveryPrefs}
          stats={snapshot.discoveries}
          onchange={(prefs) => {
            discoveryPrefs = prefs;
          }}
          onfocus={(group) => {
            void exploreDiscovery(group);
          }}
        />
      {/if}
      <JumpForm onjump={(x, z) => viewer?.flyTo(x, z)} onhome={returnToSpawn} />
    </div>

    <div class="bottom-left">
      <CoordinateReadout {pointed} focus={snapshot?.view} />
    </div>

    <div class="bottom-center">
      {#if hintVisible}
        <p class="glass hint">
          Drag to move, right-drag to turn, scroll to zoom. WASD, Q and E work too.
        </p>
      {/if}
      {#if dimension === "overworld" && mode === "surface"}<TimeOfDay bind:hour />{/if}
    </div>

    <div class="bottom-right">
      {#if mode === "caves" && viewer && snapshot}
        <CaveNavigation
          navigation={snapshot.navigation}
          {autoDepth}
          onauto={(enabled) => {
            autoDepth = enabled;
          }}
          onmove={(direction) => viewer?.setVerticalMovement(direction)}
          onrecover={() => {
            selectionTool = "off";
            viewer?.recoverCamera();
          }}
        />
      {/if}
      <ViewControls
        heading={snapshot?.view.heading ?? 0}
        onnorth={() => viewer?.faceNorth()}
        onzoom={(factor) => viewer?.zoom(factor)}
        {projection}
        onprojection={(next) => {
          projection = next;
          viewer?.setProjection(next);
        }}
      />
    </div>
  </div>
</main>

<style>
  .dimensions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    font-size: 12px;
    max-width: 320px;
  }

  .dimensions select {
    color: var(--text);
    background: #1b2532;
    border: 1px solid #586473;
    border-radius: 5px;
    padding: 5px 8px;
  }
  main,
  .scene {
    position: fixed;
    inset: 0;
  }

  .scene {
    background: radial-gradient(circle at 50% 30%, #1b2a3d, #0a0f16 70%);
  }

  .scene :global(canvas) {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
  }

  .overlay {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    grid-template-rows: auto 1fr auto;
    gap: 16px;
    padding: 16px;
    pointer-events: none;
  }

  .overlay > * {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .overlay > * > :global(*) {
    pointer-events: auto;
  }

  .top-left {
    grid-area: 1 / 1;
    align-items: flex-start;
  }

  .top-right {
    grid-area: 1 / 3;
    align-items: flex-end;
    max-height: calc(100vh - 130px);
    overflow-y: auto;
  }

  .bottom-left {
    grid-area: 3 / 1;
    align-self: end;
    align-items: flex-start;
  }

  .bottom-center {
    grid-area: 3 / 2;
    align-self: end;
    align-items: center;
  }

  .bottom-right {
    grid-area: 3 / 3;
    align-self: end;
    align-items: flex-end;
  }

  .hint {
    margin: 0;
    padding: 8px 14px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
  }

  .cave-hint {
    max-width: 280px;
    padding: 10px 12px;
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }

  @media (max-width: 760px) {
    .overlay {
      grid-template-columns: 1fr auto;
      grid-template-rows: auto auto 1fr auto auto;
      gap: 10px;
      padding: 10px;
    }

    .top-left {
      grid-area: 1 / 1;
    }

    .top-right {
      grid-area: 2 / 1 / 3 / 3;
      align-items: flex-start;
    }

    .bottom-left {
      grid-area: 4 / 1;
    }

    .bottom-right {
      grid-area: 4 / 2;
    }

    .bottom-center {
      grid-area: 5 / 1 / 6 / 3;
    }

    .overlay.caves {
      grid-template-rows: auto auto 1fr auto auto auto;
    }

    .caves .bottom-right {
      grid-area: 4 / 1 / 5 / 3;
      flex-direction: row;
      flex-wrap: wrap;
      justify-content: flex-end;
      align-items: flex-end;
    }

    .caves .bottom-left {
      grid-area: 5 / 1 / 6 / 3;
    }

    .caves .bottom-center {
      grid-area: 6 / 1 / 7 / 3;
    }

    .hint {
      display: none;
    }
  }
</style>
