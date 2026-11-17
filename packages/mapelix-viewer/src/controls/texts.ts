import type { DiscoveryCategory } from "@mapelix/scene-prototype/discoveries";

/**
 * Every text the controls show. Hosts pass their own (any language); `DEFAULT_CONTROL_TEXTS`
 * is English and fills what a host leaves out.
 */
export interface ControlTexts {
  readonly region: string;
  readonly zoomIn: string;
  readonly zoomOut: string;
  readonly showWorld: string;
  readonly showMap: string;
  readonly isometric: string;
  readonly toPerspective: string;
  readonly toIsometric: string;
  readonly faceNorth: string;
  readonly home: string;
  readonly dimensions: string;
  readonly dimensionName: (dimension: string) => string;
  readonly settings: string;
  readonly close: string;
  readonly world: (name: string | undefined) => string;
  readonly view: string;
  readonly surface: string;
  readonly caves: string;
  readonly cavesNeedWorld: string;
  readonly sliceThickness: string;
  readonly blocks: (count: number) => string;
  readonly sliceRange: (minY: number, maxY: number) => string;
  readonly followDepth: string;
  readonly ceiling: (y: number) => string;
  readonly ascend: string;
  readonly descend: string;
  readonly recover: string;
  readonly caveKeys: string;
  readonly openingDepth: string;
  readonly area: string;
  readonly areaHelp: string;
  readonly selectAround: string;
  readonly clearArea: string;
  readonly applyArea: string;
  readonly areaBounds: {
    readonly minX: string;
    readonly maxX: string;
    readonly minZ: string;
    readonly maxZ: string;
  };
  readonly areaTool: string;
  readonly areaTools: { readonly off: string; readonly move: string; readonly resize: string };
  readonly atmosphere: string;
  readonly atmosphereOnly: string;
  readonly clouds: string;
  readonly textures: string;
  readonly texturesUnavailable: string;
  readonly detailedLeaves: string;
  readonly texturesFailed: string;
  readonly rain: string;
  readonly thunderstorm: string;
  readonly timeOfDay: string;
  readonly time: (hour: number) => string;
  readonly discoveries: string;
  readonly showDiscoveries: string;
  readonly discoveriesIn3D: string;
  readonly discoveriesUnavailable: string;
  readonly categories: Readonly<Record<DiscoveryCategory, string>>;
  readonly oreTypes: string;
  readonly kind: (id: string, fallback: string) => string;
  readonly exposure: string;
  readonly exposures: { readonly all: string; readonly exposed: string; readonly buried: string };
  readonly allHeights: string;
  readonly searching: (tiles: number) => string;
  readonly grouping: string;
  readonly searchDone: (blocks: number, groups: number) => string;
  readonly limited: string;
  readonly uncertain: string;
  readonly found: string;
  readonly explore: (kind: string, x: number, y: number, z: number) => string;
  readonly groupLabel: (kind: string, count: number) => string;
  readonly goTo: string;
  readonly go: string;
  readonly position: (x: number, z: number, y?: number) => string;
  readonly scale: (pixelsPerBlock: number) => string;
  readonly loading: (regions: number) => string;
  readonly changing: string;
  readonly emptyCaves: string;
  readonly hint: string;
  readonly discoveryCard: string;
}

const round = (value: number) => Number(value.toPrecision(2));

export const DEFAULT_CONTROL_TEXTS: ControlTexts = {
  region: "Map controls",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  showWorld: "Show in 3D",
  showMap: "Show the map",
  isometric: "Isometric view",
  toPerspective: "Switch to perspective view",
  toIsometric: "Switch to isometric view",
  faceNorth: "Face north",
  home: "Return home",
  dimensions: "Dimensions",
  dimensionName: (dimension) =>
    ({ overworld: "Overworld", nether: "Nether", "the-end": "The End" })[dimension] ?? dimension,
  settings: "Settings",
  close: "Close",
  world: (name) => name ?? "World",
  view: "View",
  surface: "Surface",
  caves: "Caves",
  cavesNeedWorld: "Caves need the 3D world.",
  sliceThickness: "Slice thickness",
  blocks: (count) => `${count} blocks`,
  sliceRange: (minY, maxY) => `Slice: Y ${minY} to ${maxY}`,
  followDepth: "Follow depth automatically",
  ceiling: (y) => `Hide terrain from Y ${y}`,
  ascend: "Ascend",
  descend: "Descend",
  recover: "Recover view",
  caveKeys: "Space ↑ / C ↓, or hold the buttons",
  openingDepth: "Opening next depth…",
  area: "Exploration area",
  areaHelp: "Focus on the underground beneath one location.",
  selectAround: "Select around view",
  clearArea: "Clear area",
  applyArea: "Apply area",
  areaBounds: {
    minX: "Min X",
    maxX: "Max X (exclusive)",
    minZ: "Min Z",
    maxZ: "Max Z (exclusive)",
  },
  areaTool: "3D box",
  areaTools: { off: "View only", move: "Move", resize: "Resize" },
  atmosphere: "Sky",
  atmosphereOnly: "Weather and time apply to the Overworld surface in 3D.",
  clouds: "Clouds",
  textures: "Block textures",
  texturesUnavailable: "This world has no block textures.",
  detailedLeaves: "Detailed leaves",
  texturesFailed: "Block textures could not load; blocks keep their colors.",
  rain: "Rain",
  thunderstorm: "Thunderstorm",
  timeOfDay: "Time of day",
  time: (hour) =>
    `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.floor((hour % 1) * 60)).padStart(2, "0")}`,
  discoveries: "Discoveries",
  showDiscoveries: "Show discoveries",
  discoveriesIn3D: "Discoveries show in 3D.",
  discoveriesUnavailable: "Discoveries are unavailable for this world source.",
  categories: {
    ores: "Ores",
    spawners: "Spawners",
    containers: "Containers",
    vaults: "Vaults",
    amethyst: "Amethyst",
    sculk: "Sculk",
    landmarks: "Portals and rails",
  },
  oreTypes: "Ore types",
  kind: (_id, fallback) => fallback,
  exposure: "Exposure",
  exposures: { all: "All blocks", exposed: "Exposed surfaces", buried: "Fully buried" },
  allHeights: "Search all heights",
  searching: (tiles) => `Searching ${tiles} nearby tiles…`,
  grouping: "Grouping nearby discoveries…",
  searchDone: (blocks, groups) => `${blocks} blocks in ${groups} groups`,
  limited:
    "Showing the nearest results within the search budget. Move closer or narrow the filters.",
  uncertain: "Exposure is uncertain for some blocks bordering unsaved chunks.",
  found: "Discoveries found",
  explore: (kind, x, y, z) => `Explore ${kind} at ${x}, ${y}, ${z}`,
  groupLabel: (kind, count) => `${kind} × ${count}`,
  goTo: "Go to coordinates",
  go: "Go",
  position: (x, z, y) => (y === undefined ? `X ${x} · Z ${z}` : `X ${x} · Y ${y} · Z ${z}`),
  scale: (pixels) =>
    pixels >= 1 ? `${round(pixels)} px/block` : `1 px = ${round(1 / pixels)} blocks`,
  loading: (regions) => `Loading ${regions} regions…`,
  changing: "Loading…",
  emptyCaves: "No cave surfaces here. Change depth or move to another area.",
  hint: "Drag to move, pinch or scroll to zoom. In 3D, turn with two fingers or the right button.",
  discoveryCard: "Selected discovery",
};
