<script lang="ts">
  import type { Attachment } from "svelte/attachments";

  import CoordinateReadout from "$lib/components/CoordinateReadout.svelte";
  import DebugPanel from "$lib/components/DebugPanel.svelte";
  import JumpForm from "$lib/components/JumpForm.svelte";
  import StatusCard from "$lib/components/StatusCard.svelte";
  import TimeOfDay from "$lib/components/TimeOfDay.svelte";
  import ViewControls from "$lib/components/ViewControls.svelte";
  import { readViewFromUrl, writeViewToUrl } from "$lib/view-url";
  import type { Pointed, ViewerSnapshot, WorldInfo, WorldViewer } from "$lib/viewer/world-viewer";

  const DEFAULT_HOUR = 15.5;

  let world = $state.raw<WorldInfo>();
  let viewer = $state.raw<WorldViewer>();
  let snapshot = $state.raw<ViewerSnapshot>();
  let pointed = $state.raw<Pointed>();
  let failure = $state<string>();
  let hour = $state(DEFAULT_HOUR);
  let debugVisible = $state(false);
  let hintVisible = $state(true);

  $effect(() => {
    viewer?.setTimeOfDay(hour);
  });

  const attachViewer: Attachment<HTMLDivElement> = (element) => {
    let disposed = false;
    let created: WorldViewer | undefined;
    let polling: ReturnType<typeof setInterval> | undefined;
    let lastUrl = "";
    const start = readViewFromUrl(new URL(window.location.href));
    hour = start.hour ?? DEFAULT_HOUR;

    void (async () => {
      const [{ WorldViewer }, response] = await Promise.all([
        import("$lib/viewer/world-viewer"),
        fetch("/world.json"),
      ]);
      if (!response.ok) throw new Error(`The world could not be opened (${response.status})`);
      const info: WorldInfo = await response.json();
      if (disposed) return;
      world = info;
      created = await WorldViewer.create(element, info, start.view);
      if (disposed) {
        created.dispose();
        return;
      }
      viewer = created;
      polling = setInterval(() => {
        snapshot = created?.snapshot();
        if (snapshot === undefined) return;
        const key = JSON.stringify([snapshot.view, hour]);
        if (key !== lastUrl) writeViewToUrl(snapshot.view, hour);
        lastUrl = key;
      }, 250);
    })().catch((cause: unknown) => {
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

  <div class="overlay">
    <div class="top-left">
      <StatusCard name={world?.name} loading={snapshot?.streaming.loading ?? 0} {failure} />
      {#if debugVisible && snapshot !== undefined}
        <DebugPanel {snapshot} />
      {/if}
    </div>

    <div class="top-right">
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
      <TimeOfDay bind:hour />
    </div>

    <div class="bottom-right">
      <ViewControls
        heading={snapshot?.view.heading ?? 0}
        onnorth={() => viewer?.faceNorth()}
        onzoom={(factor) => viewer?.zoom(factor)}
      />
    </div>
  </div>
</main>

<style>
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

    .hint {
      display: none;
    }
  }
</style>
