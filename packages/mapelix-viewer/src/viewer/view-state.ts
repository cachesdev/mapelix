import type { MapView } from "../map/tile-math.js";

export type ViewMode = "2d" | "3d";
export type Projection = "isometric" | "perspective";

/** The one view shared by the 2D map and the 3D world. */
export interface ViewState {
  readonly mode: ViewMode;
  readonly dimension: string;
  /** Center of the view, in blocks. */
  readonly x: number;
  readonly z: number;
  /** CSS pixels covered by one block at the center of the view. */
  readonly pixelsPerBlock: number;
  /** Radians clockwise from north; 0 keeps north up, as on the map. */
  readonly heading: number;
  /** Radians above the horizon; the map looks straight down. */
  readonly pitch: number;
  readonly projection: Projection;
}

/**
 * Scales at which the view changes mode, in CSS pixels per block. The map turns into the 3D
 * world when it rests above `toWorld`, and the world turns back into the map when it rests
 * below `toMap`. The gap between the two keeps a view near one scale from flipping back and forth.
 */
export interface SwitchThresholds {
  readonly toWorld: number;
  readonly toMap: number;
}

export const DEFAULT_THRESHOLDS: SwitchThresholds = { toWorld: 5, toMap: 4 };

/** The most top-down pitch the 3D camera allows, in radians above the horizon. */
export const TOP_DOWN_PITCH = Math.PI / 2 - 0.04;

/** Vertical field of view of the 3D camera, in degrees. */
export const WORLD_FIELD_OF_VIEW = 50;

export function checkThresholds(thresholds: SwitchThresholds): SwitchThresholds {
  const { toWorld, toMap } = thresholds;
  if (!Number.isFinite(toWorld) || !Number.isFinite(toMap) || toMap <= 0)
    throw new RangeError("Switch thresholds must be positive numbers");
  if (toMap >= toWorld)
    throw new RangeError("The return-to-map scale must be below the switch-to-3D scale");
  return { toWorld, toMap };
}

/** The mode a view at rest should be in, given the mode it is in now. */
export function restingMode(
  mode: ViewMode,
  pixelsPerBlock: number,
  thresholds: SwitchThresholds,
): ViewMode {
  if (mode === "2d") return pixelsPerBlock > thresholds.toWorld ? "3d" : "2d";
  return pixelsPerBlock < thresholds.toMap ? "2d" : "3d";
}

/** Camera distance at which one block covers `pixelsPerBlock` CSS pixels on the focus plane. */
export function cameraDistance(
  pixelsPerBlock: number,
  cssHeight: number,
  fieldOfView = WORLD_FIELD_OF_VIEW,
): number {
  return cssHeight / (2 * pixelsPerBlock * Math.tan((fieldOfView * Math.PI) / 360));
}

/** A 3D camera over the center of a map view, looking straight down with north up. */
export function cameraOverMap(view: MapView, cssHeight: number) {
  return {
    x: view.x,
    z: view.z,
    distance: cameraDistance(view.pixelsPerBlock, cssHeight),
    heading: 0,
    pitch: TOP_DOWN_PITCH,
  };
}

/** Pitch in radians for a tilt given in degrees above the horizon, within the camera range. */
export function tiltPitch(degrees: number): number {
  if (!Number.isFinite(degrees)) throw new RangeError("Tilt must be a number of degrees");
  return Math.min(TOP_DOWN_PITCH, Math.max(Math.PI / 2 - 1.42, (degrees * Math.PI) / 180));
}

/** The same heading within (−π, π], so a turn back to north takes the short way. */
export function shortestHeading(heading: number): number {
  const turn = Math.PI * 2;
  const wrapped = ((((heading + Math.PI) % turn) + turn) % turn) - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
