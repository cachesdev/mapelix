<script lang="ts">
  import {
    DISCOVERY_CATEGORIES,
    DISCOVERY_KINDS,
    discoveryFilters,
    type DiscoveryCategory,
    type DiscoveryFilters,
    type DiscoveryGroup,
  } from "@mapelix/scene-prototype/discoveries";
  import type { DiscoveryStats } from "@mapelix/viewer/three/discovery-streamer";
  interface Props {
    filters: DiscoveryFilters;
    stats: DiscoveryStats;
    onchange: (filters: DiscoveryFilters) => void;
    onfocus: (group: DiscoveryGroup) => void;
  }
  let { filters, stats, onchange, onfocus }: Props = $props();
  const labels: Record<DiscoveryCategory, string> = {
    ores: "Ores",
    spawners: "Spawners",
    containers: "Containers",
    vaults: "Vaults",
    amethyst: "Amethyst",
    sculk: "Sculk",
    landmarks: "Portals and rails",
  };
  function update(change: Partial<DiscoveryFilters>) {
    onchange(discoveryFilters({ ...filters, ...change }));
  }
  function category(value: DiscoveryCategory, enabled: boolean) {
    update({
      categories: enabled
        ? [...filters.categories, value]
        : filters.categories.filter((entry) => entry !== value),
    });
  }
  function ore(value: string, enabled: boolean) {
    update({
      ores: enabled ? [...filters.ores, value] : filters.ores.filter((entry) => entry !== value),
    });
  }
</script>

<details class="glass discoveries">
  <summary>Discoveries {filters.enabled ? `· ${stats.matchingBlocks} blocks` : "· hidden"}</summary>
  <label class="toggle"
    ><input
      type="checkbox"
      checked={filters.enabled}
      disabled={!stats.available}
      onchange={(event) => update({ enabled: event.currentTarget.checked })}
    /> Show discoveries</label
  >
  {#if !stats.available}<p>Discoveries are unavailable for this world source.</p>{/if}
  {#if filters.enabled && stats.available}
    <div class="categories">
      {#each DISCOVERY_CATEGORIES as name}
        <label
          ><input
            type="checkbox"
            checked={filters.categories.includes(name)}
            onchange={(event) => category(name, event.currentTarget.checked)}
          />
          {labels[name]}</label
        >
      {/each}
    </div>
    {#if filters.categories.includes("ores")}
      <fieldset>
        <legend>Ore types</legend>
        <div class="categories">
          {#each DISCOVERY_KINDS.filter((entry) => entry.category === "ores") as type}
            <label
              ><input
                type="checkbox"
                checked={filters.ores.includes(type.id)}
                onchange={(event) => ore(type.id, event.currentTarget.checked)}
              />
              {type.label}</label
            >
          {/each}
        </div>
      </fieldset>
    {/if}
    <label for="discovery-exposure">Exposure</label>
    <select
      id="discovery-exposure"
      value={filters.exposure}
      onchange={(event) =>
        update({ exposure: event.currentTarget.value as DiscoveryFilters["exposure"] })}
    >
      <option value="all">All blocks</option>
      <option value="exposed">Exposed surfaces</option>
      <option value="buried">Fully buried</option>
    </select>
    <label class="toggle"
      ><input
        type="checkbox"
        checked={filters.allHeights}
        onchange={(event) => update({ allHeights: event.currentTarget.checked })}
      /> Search all heights</label
    >
    <p role="status" aria-label="Discovery search status">
      {stats.remaining
        ? `Searching ${stats.remaining} nearby tiles…`
        : stats.grouping
          ? "Grouping nearby discoveries…"
          : "Nearby search complete"}
      · {stats.matchingBlocks} blocks in {stats.groups.length} groups
    </p>
    {#if stats.limited}<p>
        Showing the nearest results within the search budget. Move closer or narrow the filters.
      </p>{/if}
    {#if stats.error}<p role="alert">{stats.error}</p>{/if}
    {#if stats.groups.some((group) => group.unknown > 0)}<p>
        Exposure is uncertain for some blocks bordering unsaved chunks.
      </p>{/if}
    <ul aria-label="Discoveries found">
      {#each stats.groups.slice(0, 40) as group (group.id)}
        <li>
          <button
            onclick={() => onfocus(group)}
            aria-label={`Explore ${DISCOVERY_KINDS[group.kind]?.label} at ${group.x}, ${group.y}, ${group.z}`}
          >
            <span>{DISCOVERY_KINDS[group.kind]?.label} × {group.count}</span>
            <small>X {group.x} · Y {group.y} · Z {group.z}</small>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</details>

<style>
  .discoveries {
    padding: 10px 12px;
    width: 320px;
    max-width: calc(100vw - 24px);
    font-size: 12px;
  }
  summary {
    cursor: pointer;
  }
  p,
  small {
    color: var(--muted);
    line-height: 1.4;
  }
  .toggle {
    display: flex;
    align-items: center;
    gap: 5px;
    margin: 10px 0;
  }
  .categories {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin: 10px 0;
  }
  fieldset {
    border: 1px solid #586473;
    border-radius: 5px;
    margin: 10px 0;
    padding: 5px;
  }
  select,
  button {
    color: var(--text);
    background: #1b2532;
    border: 1px solid #586473;
    border-radius: 5px;
    padding: 5px 8px;
  }
  ul {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    max-height: 210px;
    overflow-y: auto;
  }
  li + li {
    margin-top: 5px;
  }
  button {
    display: flex;
    flex-direction: column;
    gap: 3px;
    cursor: pointer;
    width: 100%;
    text-align: left;
  }
</style>
