<script lang="ts">
  import { onMount } from "svelte";

  interface Pack {
    readonly name: string;
    readonly version?: readonly number[];
  }
  interface Status {
    readonly textures: { readonly revision: string; readonly packs: readonly Pack[] } | null;
    readonly busy: string | null;
    readonly maxBytes: number;
    readonly vanillaUrl: string;
  }
  interface Report {
    readonly ok: boolean;
    readonly errors: readonly string[];
    readonly revision?: string;
    readonly atlas?: { readonly tiles: number; readonly gpuBytes: number };
  }

  let status = $state<Status>();
  let working = $state<string>();
  let message = $state<string>();
  let failed = $state(false);
  let file = $state<HTMLInputElement>();

  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

  async function refresh(): Promise<void> {
    const response = await fetch("/demo/textures", { cache: "no-store" });
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
      message = report.ok
        ? report.revision === undefined
          ? "Textures removed."
          : `Textures ready: revision ${report.revision}, ${report.atlas?.tiles ?? 0} tiles, ${mib(report.atlas?.gpuBytes ?? 0)} on the GPU.`
        : `Refused: ${report.errors.join("; ")}`;
    } catch (cause) {
      failed = true;
      message = cause instanceof Error ? cause.message : String(cause);
    } finally {
      working = undefined;
      await refresh();
    }
  }

  const headers = { "x-mapelix-demo": "1" };

  function upload(): void {
    const chosen = file?.files?.[0];
    if (chosen === undefined) return;
    if (status !== undefined && chosen.size > status.maxBytes) {
      failed = true;
      message = `The pack is larger than ${mib(status.maxBytes)}.`;
      return;
    }
    void change(`Uploading ${chosen.name}…`, () =>
      fetch("/demo/textures", {
        method: "POST",
        headers: { ...headers, "content-type": "application/zip" },
        body: chosen,
      }),
    );
  }

  onMount(() => {
    void refresh();
  });
</script>

<svelte:head>
  <title>Texture pack · Mapelix</title>
</svelte:head>

<main>
  <h1>Texture pack</h1>
  <p>
    The 3D world draws blocks with this pack near the camera, once textures are turned on in the map
    settings. Open maps pick up a new pack by themselves.
  </p>

  <section aria-live="polite">
    {#if status === undefined}
      <p>Loading…</p>
    {:else if status.textures === null}
      <p>No pack: blocks keep their colors.</p>
    {:else}
      <p>
        In use: {status.textures.packs.map((pack) => pack.name).join(", ")}
        <span class="revision">({status.textures.revision})</span>
      </p>
    {/if}
    {#if working}
      <p>{working}</p>
    {:else if message}
      <p class:failed>{message}</p>
    {/if}
  </section>

  <section>
    <h2>Upload a pack</h2>
    <p>
      A Bedrock resource pack as a <code>.zip</code> or <code>.mcpack</code> file{status
        ? `, up to ${mib(status.maxBytes)}`
        : ""}.
    </p>
    <input bind:this={file} type="file" accept=".zip,.mcpack" disabled={working !== undefined} />
    <button type="button" onclick={upload} disabled={working !== undefined}>Use this pack</button>
  </section>

  <section>
    <h2>Vanilla pack</h2>
    <p>
      Downloads the resource pack of Mojang's Bedrock samples once, then uses it.
      {#if status}<span class="source">{status.vanillaUrl}</span>{/if}
    </p>
    <button
      type="button"
      disabled={working !== undefined}
      onclick={() =>
        change("Downloading the vanilla pack…", () =>
          fetch("/demo/textures?source=vanilla", { method: "POST", headers }),
        )}>Use the vanilla pack</button
    >
  </section>

  <section>
    <h2>No textures</h2>
    <button
      type="button"
      disabled={working !== undefined || status?.textures === null}
      onclick={() =>
        change("Removing the textures…", () =>
          fetch("/demo/textures", { method: "DELETE", headers }),
        )}>Remove the textures</button
    >
  </section>

  <p><a href="/">Back to the map</a></p>
</main>

<style>
  :global(body) {
    margin: 0;
    background: #1b1d22;
    color: #eef0f3;
    font:
      15px/1.4 system-ui,
      sans-serif;
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
  button:disabled {
    opacity: 0.5;
  }
  input {
    display: block;
    max-width: 100%;
  }
  .failed {
    color: #ff9c9c;
  }
  .revision,
  .source {
    color: #9aa3ad;
    word-break: break-all;
  }
  a {
    color: #7fb4ff;
  }
</style>
