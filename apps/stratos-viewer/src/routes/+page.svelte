<script lang="ts">
  import type {
    LatLngBoundsExpression,
    LeafletMouseEvent,
    Map as LeafletMap,
    TileLayer,
  } from "leaflet";
  import type { Attachment } from "svelte/attachments";

  interface WorldMetadata {
    readonly name: string;
    readonly tileRevision: string;
    readonly tileCount: number;
    readonly subchunkCount: number;
    readonly bounds: {
      readonly minX: number;
      readonly minZ: number;
      readonly maxX: number;
      readonly maxZ: number;
    };
    readonly hotspot: {
      readonly x: number;
      readonly z: number;
      readonly subchunkCount: number;
    };
  }

  let map: LeafletMap | undefined;
  let layer: TileLayer | undefined;
  let status = $state("Indexing world…");
  let metadata = $state<WorldMetadata>();
  let pointerX = $state(0);
  let pointerZ = $state(0);
  let centerX = $state(0);
  let centerZ = $state(0);
  let jumpX = $state(0);
  let jumpZ = $state(0);
  let zoom = $state(0);

  const attachMap: Attachment<HTMLDivElement> = (element) => {
    let disposed = false;

    void Promise.all([import("leaflet"), fetch("/world.json")])
      .then(async ([leaflet, response]) => {
        if (!response.ok) {
          throw new Error(`World metadata failed with ${response.status}`);
        }
        const world = (await response.json()) as WorldMetadata;
        if (disposed) {
          return;
        }

        metadata = world;
        jumpX = world.hotspot.x;
        jumpZ = world.hotspot.z;
        map = leaflet
          .map(element, {
            crs: leaflet.CRS.Simple,
            attributionControl: false,
            minZoom: -4,
            maxZoom: 4,
            zoomControl: false,
          })
          .setView([-world.hotspot.z, world.hotspot.x], 0);

        leaflet.control.zoom({ position: "bottomright" }).addTo(map);
        const bounds: LatLngBoundsExpression = [
          [-world.bounds.maxZ, world.bounds.minX],
          [-world.bounds.minZ, world.bounds.maxX],
        ];
        layer = leaflet
          .tileLayer(`/tiles/{z}/{x}/{y}.png?revision=${encodeURIComponent(world.tileRevision)}`, {
            bounds,
            tileSize: 256,
            minZoom: -4,
            maxZoom: 4,
            minNativeZoom: 0,
            maxNativeZoom: 3,
            noWrap: true,
            keepBuffer: 2,
          })
          .addTo(map);

        layer.on("loading", () => (status = "Rendering visible tiles…"));
        layer.on("load", () => (status = "Ready"));
        layer.on("tileerror", () => (status = "A tile could not be rendered"));
        map.on("mousemove", (event: LeafletMouseEvent) => {
          pointerX = Math.floor(event.latlng.lng);
          pointerZ = Math.floor(-event.latlng.lat);
        });
        map.on("moveend zoomend", updateViewportState);
        updateViewportState();
        status = "Rendering visible tiles…";
      })
      .catch((cause: unknown) => {
        status = cause instanceof Error ? cause.message : "Could not open world";
      });

    return () => {
      disposed = true;
      layer?.remove();
      map?.remove();
      layer = undefined;
      map = undefined;
    };
  };

  function updateViewportState(): void {
    const center = map?.getCenter();
    if (center === undefined) {
      return;
    }
    centerX = Math.round(center.lng);
    centerZ = Math.round(-center.lat);
    zoom = map?.getZoom() ?? 0;
  }

  function jumpToCoordinates(event: SubmitEvent): void {
    event.preventDefault();
    map?.setView([-jumpZ, jumpX], Math.max(1, map.getZoom()));
  }

  function returnToHotspot(): void {
    if (metadata !== undefined) {
      map?.setView([-metadata.hotspot.z, metadata.hotspot.x], 0);
    }
  }
</script>

<svelte:head>
  <title>Mapelix Viewer</title>
  <meta
    name="description"
    content="A prototype browser for Minecraft Bedrock worlds rendered by Mapelix."
  />
</svelte:head>

<div class="shell">
  <header class="topbar">
    <div class="identity">
      <span class="mark" aria-hidden="true"></span>
      <div>
        <p class="eyebrow">MAPELIX / PROTOTYPE</p>
        <h1>{metadata?.name ?? "WORLD"}</h1>
      </div>
    </div>

    <div class="status" aria-live="polite">
      <span class:ready={status === "Ready"}></span>
      {status}
    </div>
  </header>

  <main>
    <div class="map" aria-label="Interactive Bedrock world map" {@attach attachMap}></div>

    <aside class="panel">
      <section>
        <p class="eyebrow">CURSOR</p>
        <div class="coordinate-pair">
          <div><span>X</span><strong>{pointerX.toLocaleString()}</strong></div>
          <div><span>Z</span><strong>{pointerZ.toLocaleString()}</strong></div>
        </div>
      </section>

      <section class="viewport">
        <p class="eyebrow">VIEWPORT</p>
        <dl>
          <div>
            <dt>Center</dt>
            <dd>{centerX.toLocaleString()}, {centerZ.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Zoom</dt>
            <dd>{zoom > 0 ? `+${zoom}` : zoom}</dd>
          </div>
          <div>
            <dt>Tiles</dt>
            <dd>{metadata?.tileCount.toLocaleString() ?? "—"}</dd>
          </div>
          <div>
            <dt>Subchunks</dt>
            <dd>{metadata?.subchunkCount.toLocaleString() ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section>
        <p class="eyebrow">GO TO BLOCK</p>
        <form onsubmit={jumpToCoordinates}>
          <label>X <input type="number" bind:value={jumpX} /></label>
          <label>Z <input type="number" bind:value={jumpZ} /></label>
          <button type="submit">Locate</button>
        </form>
        <button class="secondary" type="button" onclick={returnToHotspot} disabled={!metadata}>
          Return to densest region
        </button>
      </section>
    </aside>

    <div class="legend" aria-label="Map legend">
      <span><i class="terrain"></i>Terrain</span>
      <span><i class="water"></i>Water</span>
      <span><i class="missing"></i>Unexplored / missing</span>
    </div>
  </main>
</div>

<style>
  .shell {
    display: grid;
    grid-template-rows: 74px minmax(0, 1fr);
    width: 100vw;
    height: 100vh;
    background: #0b0e0c;
  }

  .topbar {
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 24px;
    border-bottom: 1px solid #293129;
    background: rgba(11, 14, 12, 0.96);
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.24);
  }

  .identity {
    display: flex;
    align-items: center;
    gap: 13px;
  }

  .mark {
    width: 28px;
    height: 28px;
    border: 1px solid #8cad65;
    background:
      linear-gradient(90deg, transparent 46%, #8cad65 47% 53%, transparent 54%),
      linear-gradient(transparent 46%, #8cad65 47% 53%, transparent 54%);
    transform: rotate(45deg);
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    margin-top: 2px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22px;
    font-weight: 500;
    letter-spacing: 0.01em;
  }

  .eyebrow {
    color: #91a091;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
  }

  .status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: #b6c0b7;
    font-size: 12px;
  }

  .status span {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #d1a45a;
    box-shadow: 0 0 10px rgba(209, 164, 90, 0.6);
  }

  .status span.ready {
    background: #86b766;
    box-shadow: 0 0 10px rgba(134, 183, 102, 0.65);
  }

  main {
    position: relative;
    min-height: 0;
  }

  .map {
    width: 100%;
    height: 100%;
    background-color: #111713;
    background-image:
      linear-gradient(#1d251f 1px, transparent 1px),
      linear-gradient(90deg, #1d251f 1px, transparent 1px);
    background-size: 32px 32px;
  }

  .panel {
    position: absolute;
    z-index: 800;
    top: 20px;
    left: 20px;
    width: 238px;
    overflow: hidden;
    border: 1px solid rgba(94, 112, 96, 0.56);
    border-radius: 2px;
    background: rgba(13, 17, 14, 0.92);
    box-shadow: 0 18px 46px rgba(0, 0, 0, 0.36);
    backdrop-filter: blur(12px);
  }

  section {
    padding: 17px;
    border-bottom: 1px solid #293129;
  }

  section:last-child {
    border-bottom: 0;
  }

  .coordinate-pair {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1px;
    margin-top: 11px;
    background: #293129;
  }

  .coordinate-pair div {
    min-width: 0;
    padding: 10px;
    background: #151a16;
  }

  .coordinate-pair span,
  label {
    display: block;
    color: #91a091;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.13em;
  }

  .coordinate-pair strong {
    display: block;
    margin-top: 4px;
    overflow: hidden;
    color: #f0f5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    font-size: 15px;
    font-weight: 500;
    text-overflow: ellipsis;
  }

  dl {
    display: grid;
    gap: 7px;
    margin: 11px 0 0;
    font-size: 12px;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }

  dt {
    color: #7f8d81;
  }

  dd {
    margin: 0;
    font-family: "SFMono-Regular", Consolas, monospace;
    color: #d4ddd4;
    text-align: right;
  }

  form {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 11px;
  }

  input {
    width: 100%;
    margin-top: 5px;
    padding: 8px;
    border: 1px solid #364138;
    border-radius: 2px;
    outline: none;
    color: #f0f5ef;
    font-family: "SFMono-Regular", Consolas, monospace;
    background: #111612;
  }

  input:focus {
    border-color: #87a867;
    box-shadow: 0 0 0 2px rgba(135, 168, 103, 0.13);
  }

  button {
    grid-column: 1 / -1;
    padding: 9px 12px;
    border: 1px solid #89aa68;
    border-radius: 2px;
    color: #10150f;
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: #95b971;
    cursor: pointer;
  }

  button:hover {
    background: #a5c780;
  }

  button.secondary {
    width: 100%;
    margin-top: 8px;
    border-color: #3c483e;
    color: #aeb9af;
    background: transparent;
  }

  button:disabled {
    opacity: 0.48;
    cursor: wait;
  }

  .legend {
    position: absolute;
    z-index: 800;
    right: 22px;
    bottom: 22px;
    display: flex;
    gap: 16px;
    padding: 9px 12px;
    border: 1px solid rgba(72, 87, 75, 0.68);
    border-radius: 2px;
    color: #aeb8af;
    font-size: 10px;
    letter-spacing: 0.04em;
    background: rgba(13, 17, 14, 0.88);
    backdrop-filter: blur(10px);
  }

  .legend span {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .legend i {
    width: 8px;
    height: 8px;
    border-radius: 1px;
  }

  .legend .terrain {
    background: #6d954d;
  }

  .legend .water {
    background: #345fa8;
  }

  .legend .missing {
    border: 1px solid #38423a;
    background: #111713;
  }

  :global(.leaflet-container) {
    font-family: inherit;
  }

  :global(.leaflet-tile) {
    image-rendering: pixelated;
  }

  :global(.leaflet-control-zoom a) {
    border-color: #39443b !important;
    color: #dbe5db !important;
    background: #111612 !important;
  }

  @media (max-width: 720px) {
    .shell {
      grid-template-rows: 62px minmax(0, 1fr);
    }

    .topbar {
      padding: 0 14px;
    }

    .status {
      max-width: 45vw;
      font-size: 10px;
      text-align: right;
    }

    .panel {
      top: 10px;
      left: 10px;
      width: 210px;
    }

    .viewport,
    .legend {
      display: none;
    }
  }
</style>
