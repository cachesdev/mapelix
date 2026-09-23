import { replaceState } from "$app/navigation";
import { page } from "$app/state";

import type { CameraView } from "$lib/viewer/world-viewer";

export interface UrlView {
  readonly view: Partial<CameraView>;
  readonly hour: number | undefined;
}

const DEGREES = Math.PI / 180;

/** Reads a shared view such as `?x=120&z=-40&distance=90&heading=45&pitch=35&hour=17`. */
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
  return { view: defined, hour: number("hour") };
}

/** Writes the current view back into the address bar so it can be shared. */
export function writeViewToUrl(view: CameraView, hour: number): void {
  const url = new URL(window.location.href);
  url.searchParams.set("x", view.x.toFixed(0));
  url.searchParams.set("z", view.z.toFixed(0));
  url.searchParams.set("distance", view.distance.toFixed(0));
  url.searchParams.set("heading", (view.heading / DEGREES).toFixed(0));
  url.searchParams.set("pitch", (view.pitch / DEGREES).toFixed(0));
  url.searchParams.set("hour", hour.toFixed(1));
  replaceState(url, page.state);
}
