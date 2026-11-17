import {
  discoveryFiltersFromSearch,
  discoveryFilterSearch,
} from "@mapelix/scene-prototype/discoveries";
import { selectionFromSearch } from "@mapelix/scene-prototype/selection";
import type { MapView } from "../map/tile-math.js";
import type { MapelixViewer, WorldSettings } from "./mapelix-viewer.js";
import type { Projection } from "./view-state.js";

/** Viewer options read back from an address: give them to `new MapelixViewer`. */
export interface SearchStart {
  readonly dimension?: string;
  readonly view: Partial<MapView>;
  readonly projection?: Projection;
  readonly settings: Partial<WorldSettings>;
}

const number = (params: URLSearchParams, name: string): number | undefined => {
  const raw = params.get(name);
  const value = raw === null || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * The view and settings as address parameters: `dimension`, `x`, `z`, `scale` (CSS pixels per
 * block), `projection`, `view=caves` with `minY` and `thickness`, `ceilingY` (Nether), `hour`,
 * `weather`, `clouds=0`, `textures=1`, `autoDepth=0`, the discovery filters and the cave area.
 */
export function viewerSearch(viewer: MapelixViewer): URLSearchParams {
  const view = viewer.view;
  const settings = viewer.settings;
  const params = new URLSearchParams({
    dimension: view.dimension,
    x: String(Math.round(view.x)),
    z: String(Math.round(view.z)),
    scale: String(Number(view.pixelsPerBlock.toPrecision(3))),
    projection: view.projection,
  });
  if (settings.viewMode === "caves") {
    params.set("view", "caves");
    params.set("minY", String(settings.caveMinY));
    params.set("thickness", String(settings.caveThickness));
  }
  if (view.dimension === "nether") params.set("ceilingY", String(settings.netherCeilingY));
  params.set("hour", String(settings.hour));
  if (settings.weather !== "clear") params.set("weather", settings.weather);
  if (!settings.clouds) params.set("clouds", "0");
  if (settings.textures === "on") params.set("textures", "1");
  if (!settings.autoDepth) params.set("autoDepth", "0");
  for (const [name, value] of discoveryFilterSearch(settings.discoveries)) params.set(name, value);
  if (settings.selection)
    for (const name of ["minX", "maxX", "minZ", "maxZ"] as const)
      params.set(name, String(settings.selection[name]));
  return params;
}

/** Reads what `viewerSearch` wrote; anything missing or invalid is left to the defaults. */
export function startFromSearch(params: URLSearchParams): SearchStart {
  const view: { -readonly [K in keyof MapView]?: MapView[K] } = {};
  const x = number(params, "x"),
    z = number(params, "z"),
    scale = number(params, "scale");
  if (x !== undefined) view.x = x;
  if (z !== undefined) view.z = z;
  if (scale !== undefined && scale > 0) view.pixelsPerBlock = scale;
  const settings: { -readonly [K in keyof WorldSettings]?: WorldSettings[K] } = {};
  if (params.get("view") === "caves") settings.viewMode = "caves";
  const minY = number(params, "minY"),
    thickness = number(params, "thickness"),
    ceilingY = number(params, "ceilingY"),
    hour = number(params, "hour");
  if (minY !== undefined && minY % 16 === 0) settings.caveMinY = minY;
  if (thickness === 16 || thickness === 32) settings.caveThickness = thickness;
  if (ceilingY !== undefined && ceilingY % 16 === 0) settings.netherCeilingY = ceilingY;
  if (hour !== undefined && hour >= 0 && hour <= 24) settings.hour = hour;
  const weather = params.get("weather");
  if (weather === "rain" || weather === "thunderstorm") settings.weather = weather;
  if (params.get("clouds") === "0") settings.clouds = false;
  if (params.get("textures") === "1") settings.textures = "on";
  if (params.get("autoDepth") === "0") settings.autoDepth = false;
  try {
    const filters = discoveryFiltersFromSearch(params);
    if (filters) settings.discoveries = filters;
  } catch {
    /* Invalid filters keep the defaults. */
  }
  try {
    const selection = selectionFromSearch(params);
    if (selection) settings.selection = selection;
  } catch {
    /* An invalid area is dropped. */
  }
  const projection = params.get("projection");
  return {
    dimension: params.get("dimension") ?? undefined,
    view,
    projection: projection === "perspective" || projection === "isometric" ? projection : undefined,
    settings,
  };
}
