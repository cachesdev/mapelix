import { replaceState } from "$app/navigation";
import { page } from "$app/state";

import type { CameraView, ViewProjection } from "$lib/viewer/world-viewer";
import { selectionFromSearch, type HorizontalSelection } from "@mapelix/scene-prototype/selection";
import {
  discoveryFiltersFromSearch,
  discoveryFilterSearch,
  type DiscoveryFilters,
} from "@mapelix/scene-prototype/discoveries";
import {
  contextFromSearch,
  contextSearch,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";

export interface UrlView {
  readonly context: SceneContext;
  readonly view: Partial<CameraView>;
  readonly hour: number | undefined;
  readonly selection: HorizontalSelection | undefined;
  readonly discoveries: DiscoveryFilters | undefined;
  readonly autoDepth: boolean | undefined;
  readonly projection: ViewProjection | undefined;
}

const DEGREES = Math.PI / 180;

/**
 * Reads a shared view such as `?x=120&y=70&z=-40&distance=90&heading=45&pitch=35&hour=17`;
 * `projection=iso` opens it in the isometric projection.
 */
export function readViewFromUrl(url: URL): UrlView {
  const number = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === "") return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  const heading = number("heading");
  const pitch = number("pitch");
  const view: Partial<Record<keyof CameraView, number>> = {
    x: number("x"),
    y: number("y"),
    z: number("z"),
    distance: number("distance"),
    heading: heading === undefined ? undefined : heading * DEGREES,
    pitch: pitch === undefined ? undefined : pitch * DEGREES,
  };
  const defined = Object.fromEntries(
    Object.entries(view).filter(([, value]) => value !== undefined),
  );
  return {
    view: defined,
    hour: number("hour"),
    context: contextFromSearch(url.searchParams),
    selection: selectionFromSearch(url.searchParams),
    discoveries: discoveryFiltersFromSearch(url.searchParams),
    autoDepth:
      url.searchParams.get("autoDepth") === "0"
        ? false
        : url.searchParams.get("autoDepth") === "1"
          ? true
          : undefined,
    projection:
      url.searchParams.get("projection") === "iso"
        ? "isometric"
        : url.searchParams.get("projection") === "perspective"
          ? "perspective"
          : undefined,
  };
}

/** Writes the current view back into the address bar so it can be shared. */
export function writeViewToUrl(
  view: CameraView,
  hour: number,
  context: SceneContextInput,
  selection?: HorizontalSelection,
  discoveries?: DiscoveryFilters,
  autoDepth?: boolean,
  projection?: ViewProjection,
): void {
  const url = new URL(window.location.href);
  if (projection === "isometric") url.searchParams.set("projection", "iso");
  else url.searchParams.delete("projection");
  if (autoDepth !== undefined) url.searchParams.set("autoDepth", autoDepth ? "1" : "0");
  for (const key of ["dimension", "ceilingY", "mode", "minY", "maxY"]) url.searchParams.delete(key);
  for (const [key, value] of contextSearch(context)) url.searchParams.set(key, value);
  for (const name of ["minX", "maxX", "minZ", "maxZ"] as const) {
    url.searchParams.delete(name);
    if (selection) url.searchParams.set(name, String(selection[name]));
  }
  for (const name of ["discover", "discoveryTypes", "ores", "exposure", "allY"])
    url.searchParams.delete(name);
  if (discoveries)
    for (const [name, value] of discoveryFilterSearch(discoveries))
      url.searchParams.set(name, value);
  url.searchParams.set("x", view.x.toFixed(0));
  url.searchParams.set("y", view.y.toFixed(0));
  url.searchParams.set("z", view.z.toFixed(0));
  url.searchParams.set("distance", view.distance.toFixed(0));
  url.searchParams.set("heading", (view.heading / DEGREES).toFixed(0));
  url.searchParams.set("pitch", (view.pitch / DEGREES).toFixed(0));
  url.searchParams.set("hour", hour.toFixed(1));
  replaceState(url, page.state);
}
