<script lang="ts">
  import { onMount } from "svelte";
  import { afterNavigate } from "$app/navigation";

  interface PackInfo {
    readonly name: string;
    readonly version: string;
  }
  interface Entry {
    readonly file: string;
    readonly label: string;
    readonly vanilla: boolean;
    readonly pack: PackInfo | null;
  }
  interface Skipped {
    readonly pack: PackInfo;
    readonly file: string;
    readonly reason: string;
  }
  interface Status {
    readonly stack: readonly Entry[];
    readonly textures: { readonly revision: string } | null;
    readonly skipped: readonly Skipped[];
    readonly errors: readonly string[];
    readonly busy: string | null;
    readonly maxBytes: number;
    readonly vanillaUrl: string;
  }
  interface Report {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly revision?: string;
    readonly atlas?: { readonly tiles: number; readonly gpuBytes: number };
    readonly skipped?: readonly Skipped[];
  }

  const API = "/demo/textures";
  const headers = { "x-mapelix-demo": "1" };

  let status = $state<Status>();
  let working = $state<string>();
  let message = $state<string>();
  let failed = $state(false);
  let file = $state<HTMLInputElement>();

  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const hasVanilla = $derived(status?.stack.some((entry) => entry.vanilla) ?? false);

  async function refresh(): Promise<void> {
    const response = await fetch(API, { cache: "no-store" });
    if (response.ok) status = (await response.json()) as Status;
  }

  async function change(label: string, request: () => Promise<Response>): Promise<void> {
    working = label;
    message = undefined;
    failed = false;
    try {
      const response = await request();
      const report = (await response.json()) as Report;
      failed = !report.ok;
      const skipped = report.skipped?.length ?? 0;
      message = report.ok
        ? report.revision === undefined
          ? "Textures removed: blocks keep their colors."
          : `Textures ready: ${report.atlas?.tiles ?? 0} tiles, ${mib(report.atlas?.gpuBytes ?? 0)} on the GPU` +
            (skipped > 0 ? `, ${skipped} image${skipped > 1 ? "s" : ""} skipped.` : ".")
        : `Refused, nothing changed: ${report.errors.join("; ")}`;
    } catch (cause) {
      failed = true;
      message = cause instanceof Error ? cause.message : String(cause);
    } finally {
      working = undefined;
      await refresh();
    }
  }

  function upload(): void {
    const chosen = file?.files?.[0];
    if (chosen === undefined) return;
    if (status !== undefined && chosen.size > status.maxBytes) {
      failed = true;
      message = `The pack is larger than ${mib(status.maxBytes)}.`;
      return;
    }
    void change(`Uploading ${chosen.name}…`, () =>
      fetch(API, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/zip",
          "x-mapelix-pack-name": encodeURIComponent(chosen.name),
        },
        body: chosen,
      }),
    ).then(() => {
      if (file) file.value = "";
    });
  }

  /** Sends the stack in a new order, or without a pack. */
  function arrange(label: string, files: readonly string[]): void {
    void change(label, () =>
      fetch(API, {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ packs: files }),
      }),
    );
  }

  function move(index: number, by: -1 | 1): void {
    if (status === undefined) return;
    const files = status.stack.map((entry) => entry.file);
    const [moved] = files.splice(index, 1);
    files.splice(index + by, 0, moved!);
    arrange("Reordering the packs…", files);
  }

  function drop(index: number): void {
    if (status === undefined) return;
    arrange(
      `Removing ${status.stack[index]!.label}…`,
      status.stack.filter((_, at) => at !== index).map((entry) => entry.file),
    );
  }

  /**
   * The map where it was: it keeps its view in its address, which the page remembers when it
   * was opened from the map; opened directly, the map's start view.
   */
  let mapHref = $state("/");
  afterNavigate(({ from }) => {
    let url = from?.url;
    if (url === undefined) {
      try {
        url = new URL(document.referrer);
      } catch {
        url = undefined;
      }
    }
    if (url !== undefined && url.origin === location.origin && url.pathname === "/")
      mapHref = `/${url.search}`;
  });

  onMount(() => {
    void refresh();
  });
</script>

<svelte:head>
  <title>Texture packs · Mapelix</title>
</svelte:head>

<!-- Its own scroll area: the map page keeps the document from scrolling. -->
<div class="page">
<header class="bar">
  <a
    class="back"
    href={mapHref}
    aria-disabled={working !== undefined}
    onclick={(event) => {
      if (working !== undefined) event.preventDefault();
    }}
    >{working !== undefined ? "Wait…" : "← Back to the map"}</a
  >
  <span class="saved">Changes apply at once</span>
</header>

<main>
  <h1>Texture packs</h1>
  <p>
    The 3D world draws blocks with these packs near the camera, once textures are turned on in the
    map settings. Open maps pick up a change by themselves.
  </p>

  <section aria-live="polite">
    <h2>Stack</h2>
    <p class="hint">
      The first pack wins: a block takes its textures from the highest pack that has them, the
      packs below fill in the rest. Keep the vanilla pack at the bottom so nothing is missing.
    </p>
    {#if status === undefined}
      <p>Loading…</p>
    {:else if status.stack.length === 0}
      <p>No pack: blocks keep their colors.</p>
    {:else}
      <ol class="stack">
        {#each status.stack as entry, index (entry.file)}
          <li>
            <span class="rank">{index === 0 ? "Wins" : index + 1}</span>
            <span class="name">
              {entry.vanilla ? "Vanilla" : entry.label}
              {#if entry.pack}
                <span class="detail">{entry.pack.name} {entry.pack.version}</span>
              {/if}
            </span>
            <button
              type="button"
              class="small"
              aria-label={`Move ${entry.label} up`}
              disabled={working !== undefined || index === 0}
              onclick={() => move(index, -1)}>↑</button
            >
            <button
              type="button"
              class="small"
              aria-label={`Move ${entry.label} down`}
              disabled={working !== undefined || index === status.stack.length - 1}
              onclick={() => move(index, 1)}>↓</button
            >
            <button
              type="button"
              class="small"
              aria-label={`Remove ${entry.label}`}
              disabled={working !== undefined}
              onclick={() => drop(index)}>✕</button
            >
          </li>
        {/each}
      </ol>
      {#if status.textures}
        <p class="detail">Revision {status.textures.revision}</p>
      {/if}
    {/if}
    {#if working}
      <p>{working}</p>
    {:else if message}
      <p class:failed>{message}</p>
    {/if}
  </section>

  {#if status && status.skipped.length > 0}
    <section>
      <h2>Skipped images</h2>
      <p class="hint">
        These images could not be used (too large or damaged). The same image of the next pack
        takes their place; without one, the block keeps its color.
      </p>
      <ul class="skipped">
        {#each status.skipped as image (`${image.pack.name}/${image.file}`)}
          <li>
            <strong>{image.pack.name}</strong> <code>{image.file}</code>:<br />
            <span class="detail">{image.reason}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <h2>Add a pack on top</h2>
    <p>
      A Bedrock resource pack as a <code>.zip</code> or <code>.mcpack</code> file{status
        ? `, up to ${mib(status.maxBytes)}`
        : ""}. It goes first, so it wins over the packs below.
    </p>
    <input bind:this={file} type="file" accept=".zip,.mcpack" disabled={working !== undefined} />
    <button type="button" onclick={upload} disabled={working !== undefined}>Add this pack</button>
  </section>

  <section>
    <h2>Vanilla pack</h2>
    <p>
      The resource pack of Mojang's Bedrock samples, downloaded once, placed at the bottom of the
      stack.
      {#if status}<span class="detail">{status.vanillaUrl}</span>{/if}
    </p>
    <button
      type="button"
      disabled={working !== undefined || hasVanilla}
      onclick={() =>
        change("Adding the vanilla pack (downloaded the first time)…", () =>
          fetch(`${API}?source=vanilla`, { method: "POST", headers }),
        )}>{hasVanilla ? "Vanilla is in the stack" : "Add the vanilla pack"}</button
    >
  </section>

  <section>
    <h2>No textures</h2>
    <button
      type="button"
      disabled={working !== undefined || status?.stack.length === 0}
      onclick={() =>
        change("Removing the textures…", () => fetch(API, { method: "DELETE", headers }))}
      >Remove every pack</button
    >
  </section>

  <p>
    <a
      class="back"
      href={mapHref}
      aria-disabled={working !== undefined}
      onclick={(event) => {
      if (working !== undefined) event.preventDefault();
    }}
      >{working !== undefined ? "Wait…" : "← Back to the map"}</a
    >
  </p>
</main>
</div>

<style>
  .page {
    position: fixed;
    inset: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    background: #1b1d22;
  }
  :global(body) {
    margin: 0;
    background: #1b1d22;
    color: #eef0f3;
    font:
      15px/1.4 system-ui,
      sans-serif;
  }
  .bar {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 10px 16px;
    background: #1b1d22ee;
    border-bottom: 1px solid #333842;
  }
  .back {
    display: inline-block;
    padding: 10px 16px;
    border-radius: 8px;
    background: #3d6fb6;
    color: #eef0f3;
    text-decoration: none;
    font-weight: 600;
  }
  .back[aria-disabled="true"] {
    opacity: 0.5;
    cursor: wait;
  }
  .saved {
    color: #9aa3ad;
    font-size: 0.85rem;
    text-align: right;
  }
  main {
    max-width: 40rem;
    margin: 0 auto;
    padding: 24px 16px;
  }
  section {
    margin: 20px 0;
    padding: 12px 16px;
    border-radius: 10px;
    background: #262a31;
  }
  h1 {
    font-size: 1.5rem;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 1.05rem;
  }
  button {
    margin-top: 6px;
    padding: 8px 14px;
    border: 0;
    border-radius: 8px;
    background: #3d6fb6;
    color: inherit;
    font: inherit;
  }
  button.small {
    margin: 0;
    min-width: 40px;
    min-height: 40px;
    padding: 0 10px;
    background: #3a3f48;
  }
  button:disabled {
    opacity: 0.5;
  }
  input {
    display: block;
    max-width: 100%;
  }
  .stack {
    margin: 8px 0;
    padding: 0;
    list-style: none;
  }
  .stack li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0;
    border-top: 1px solid #333842;
  }
  .rank {
    min-width: 3rem;
    color: #9aa3ad;
    font-size: 0.85rem;
  }
  .stack li:first-child .rank {
    color: #8fd18f;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .name .detail {
    display: block;
    font-size: 0.85rem;
  }
  .skipped {
    margin: 8px 0 0;
    padding-left: 1.2rem;
  }
  .skipped li {
    overflow-wrap: anywhere;
  }
  .hint {
    color: #c3c9d1;
  }
  .failed {
    color: #ff9c9c;
  }
  .detail {
    color: #9aa3ad;
    word-break: break-all;
  }
  a {
    color: #7fb4ff;
  }
</style>
