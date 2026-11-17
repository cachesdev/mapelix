import { TileMap, type TileMapOptions } from "../map/tile-map.js";
import type { TileIndex } from "../map/tile-index.js";
import type { MapView } from "../map/tile-math.js";
import type { WorldInfo, WorldViewer, WorldViewerOptions } from "../three/world-viewer.js";
import {
  cameraOverMap,
  checkThresholds,
  DEFAULT_THRESHOLDS,
  restingMode,
  shortestHeading,
  tiltPitch,
  TOP_DOWN_PITCH,
  type Projection,
  type SwitchThresholds,
  type ViewMode,
  type ViewState,
} from "./view-state.js";

/** Where the 3D endpoints of a world are served (see `createSceneHandler` in `@mapelix/viewer/node`). */
export interface WorldSource {
  /** URL prefix of `world.json`, `regions/` and `discoveries/`. */
  readonly base: string;
  /** Further 3D options; the region and discovery URLs come from `base`. */
  readonly options?: Omit<WorldViewerOptions, "projection" | "regionBase" | "discoveryBase">;
}

export interface MapelixViewerOptions {
  readonly tiles: TileIndex;
  /** The 3D world behind the map; without it the viewer stays a 2D map. */
  readonly world?: WorldSource;
  readonly dimension?: string;
  readonly view?: Partial<MapView>;
  /** Scales at which the view changes mode (default: 3D above 5, map below 4 px/block). */
  readonly thresholds?: SwitchThresholds;
  /** 3D projection (default isometric). */
  readonly projection?: Projection;
  /**
   * Tilt the 3D camera to this many degrees above the horizon after it takes over from the map.
   * Off by default: the world first shows straight down, like the map.
   */
  readonly autoTilt?: number;
  /** Extra 2D map options. */
  readonly map?: Pick<
    TileMapOptions,
    "minPixelsPerBlock" | "maxCachedTiles" | "maxRequests" | "background" | "onIdle"
  >;
  /** Accessible name of the view. */
  readonly label?: string;
  readonly onViewChange?: (view: ViewState) => void;
  readonly onModeChange?: (mode: ViewMode) => void;
  /** The 3D world could not be shown; the viewer stays a 2D map. */
  readonly onWorldError?: (error: unknown) => void;
}

/** Scale the 2D map can reach (the 3D world normally takes over well before). */
const MAP_MAX_SCALE = 32;
/** Time the 3D layer waits for terrain before it shows anyway, in ms. */
const WORLD_READY_TIMEOUT = 2500;
const FADE_MS = 220;
const TURN_MS = 380;
const TILT_MS = 700;
const POLL_MS = 100;
/** Time without a wheel event after which the 3D view counts as at rest, in ms. */
const WHEEL_REST_MS = 250;

type WorldModule = typeof import("../three/world-viewer.js");

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * One view of a world: a light 2D tile map that turns into the 3D world at the same center
 * and scale when zoomed in past `thresholds.toWorld`, and back into the map when zoomed out
 * below `thresholds.toMap`. The 3D engine loads only when first needed.
 */
export class MapelixViewer {
  readonly map: TileMap;
  private readonly element: HTMLElement;
  private readonly options: MapelixViewerOptions;
  private readonly mapLayer: HTMLDivElement;
  private readonly worldLayer: HTMLDivElement;
  private worldViewer: WorldViewer | undefined;
  private modeNow: ViewMode = "2d";
  private switching = false;
  private thresholdValues: SwitchThresholds;
  private projectionChoice: Projection;
  private autoTiltDegrees: number | undefined;
  private worldModule: Promise<WorldModule> | undefined;
  private readonly worlds = new Map<string, Promise<WorldInfo>>();
  private worldBroken = false;
  private readonly pointers = new Set<number>();
  private lastWheel = 0;
  private poll = 0;
  private tween = 0;
  private lastState: ViewState;
  private generation = 0;
  private disposed = false;

  constructor(element: HTMLElement, options: MapelixViewerOptions) {
    this.element = element;
    this.options = options;
    this.thresholdValues = checkThresholds(options.thresholds ?? DEFAULT_THRESHOLDS);
    this.projectionChoice = options.projection ?? "isometric";
    if (options.autoTilt !== undefined) tiltPitch(options.autoTilt);
    this.autoTiltDegrees = options.autoTilt;
    if (getComputedStyle(element).position === "static") element.style.position = "relative";
    this.mapLayer = this.layer();
    this.worldLayer = this.layer();
    this.worldLayer.style.opacity = "0";
    this.worldLayer.style.visibility = "hidden";
    this.worldLayer.style.touchAction = "none";
    this.worldLayer.style.pointerEvents = "none";
    for (const layer of [this.mapLayer, this.worldLayer])
      layer.style.transition = `opacity ${FADE_MS}ms ease-out`;
    for (const [type, listener] of this.worldListeners)
      this.worldLayer.addEventListener(type, listener, { passive: true, capture: true });
    // Keys follow the pointer: a press on the view takes the focus back from any control.
    element.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.worldLayer.addEventListener("keydown", this.onWorldKey);
    this.map = new TileMap(this.mapLayer, {
      ...options.map,
      index: options.tiles,
      dimension: options.dimension,
      view: options.view,
      maxPixelsPerBlock: MAP_MAX_SCALE,
      label: options.label,
      onRest: () => this.mapRested(),
      onViewChange: () => this.emit(),
    });
    this.lastState = this.mapState();
    // A view that starts zoomed in past the switch scale opens in 3D.
    queueMicrotask(() => this.mapRested());
  }

  /** The shared view: center, scale and, in 3D, the camera direction. */
  get view(): ViewState {
    return this.modeNow === "3d" && this.worldViewer !== undefined
      ? this.worldState(this.worldViewer)
      : this.mapState();
  }

  get mode(): ViewMode {
    return this.modeNow;
  }

  get dimension(): string {
    return this.map.dimension;
  }

  /** The 3D viewer while it is shown, for hosts that use more of its API. */
  get world(): WorldViewer | undefined {
    return this.modeNow === "3d" ? this.worldViewer : undefined;
  }

  /** True when a 3D world is configured and has not failed. */
  get hasWorld(): boolean {
    return this.options.world !== undefined && !this.worldBroken;
  }

  get thresholds(): SwitchThresholds {
    return this.thresholdValues;
  }

  setThresholds(thresholds: SwitchThresholds): void {
    this.thresholdValues = checkThresholds(thresholds);
    if (this.modeNow === "2d") this.mapRested();
  }

  get projection(): Projection {
    return this.projectionChoice;
  }

  setProjection(projection: Projection): void {
    this.projectionChoice = projection;
    this.worldViewer?.setProjection(projection);
    this.emit();
  }

  get autoTilt(): number | undefined {
    return this.autoTiltDegrees;
  }

  /** Degrees above the horizon to tilt to after switching to 3D; undefined turns it off. */
  setAutoTilt(degrees: number | undefined): void {
    if (degrees !== undefined) tiltPitch(degrees);
    this.autoTiltDegrees = degrees;
  }

  setDimension(dimension: string): void {
    if (dimension === this.map.dimension) return;
    if (this.modeNow === "3d") void this.showMap(false);
    else {
      // Drops a 3D world still loading for the previous dimension.
      this.generation++;
      this.hideWorldLayer();
    }
    this.switching = false;
    this.map.setDimension(dimension);
    this.emit();
  }

  /**
   * Gives the keyboard focus to the view shown: arrows and +/− on the map; WASD, arrows, Q/E,
   * R/F (and Space/C in caves) in 3D. Hosts call it after a pointer press on their own controls,
   * so a focused button never takes those keys.
   */
  focus(): void {
    this.focusTarget()?.focus({ preventScroll: true });
  }

  /** Zooms in (`factor` > 1) or out around the center, in either mode. */
  zoomBy(factor: number): void {
    if (this.modeNow === "3d" && this.worldViewer !== undefined) this.worldViewer.zoom(1 / factor);
    else this.map.zoomBy(factor);
  }

  /** Switches to the 3D world at the current center, zoomed in to the switch scale if needed. */
  async showWorld(): Promise<boolean> {
    if (this.modeNow === "3d") return true;
    return this.enterWorld();
  }

  /** Turns the 3D world back north and straight down, then shows the map at the same view. */
  async showMap(animate = true): Promise<void> {
    if (this.modeNow === "2d" || this.worldViewer === undefined) return;
    await this.leaveWorld(animate);
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    cancelAnimationFrame(this.tween);
    clearInterval(this.poll);
    this.worldViewer?.dispose();
    this.worldViewer = undefined;
    this.element.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.map.dispose();
    this.mapLayer.remove();
    this.worldLayer.remove();
  }

  private focusTarget(): HTMLElement | undefined {
    if (this.modeNow === "3d") return this.worldLayer.querySelector("canvas") ?? undefined;
    return this.mapLayer;
  }

  /** After a switch, the newly shown view keeps the focus the other one had. */
  private moveFocus(): void {
    const active = document.activeElement;
    if (active === null || active === document.body || this.element.contains(active)) this.focus();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = this.focusTarget();
    if (target !== undefined && event.target instanceof Node && target.contains(event.target))
      if (document.activeElement !== target) target.focus({ preventScroll: true });
  };

  /** `+` and `−` zoom the 3D view as they zoom the map. */
  private readonly onWorldKey = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || this.modeNow !== "3d") return;
    const factor = event.key === "+" || event.key === "=" ? 2 : event.key === "-" ? 0.5 : 0;
    if (factor === 0) return;
    event.preventDefault();
    this.zoomBy(factor);
  };

  private layer(): HTMLDivElement {
    const layer = document.createElement("div");
    layer.style.position = "absolute";
    layer.style.inset = "0";
    this.element.append(layer);
    return layer;
  }

  private mapState(): ViewState {
    const view = this.map.view;
    return {
      mode: this.modeNow,
      dimension: this.map.dimension,
      x: view.x,
      z: view.z,
      pixelsPerBlock: view.pixelsPerBlock,
      heading: 0,
      pitch: TOP_DOWN_PITCH,
      projection: this.projectionChoice,
    };
  }

  private worldState(world: WorldViewer): ViewState {
    const snapshot = world.snapshot();
    return {
      mode: this.modeNow,
      dimension: this.map.dimension,
      x: snapshot.view.x,
      z: snapshot.view.z,
      pixelsPerBlock: snapshot.projection.pixelsPerBlock,
      heading: snapshot.view.heading,
      pitch: snapshot.view.pitch,
      projection: this.projectionChoice,
    };
  }

  private emit(): void {
    const state = this.view;
    const last = this.lastState;
    this.lastState = state;
    if (
      state.mode !== last.mode ||
      state.dimension !== last.dimension ||
      state.x !== last.x ||
      state.z !== last.z ||
      state.pixelsPerBlock !== last.pixelsPerBlock ||
      state.heading !== last.heading ||
      state.pitch !== last.pitch ||
      state.projection !== last.projection
    )
      this.options.onViewChange?.(state);
  }

  private mapRested(): void {
    if (this.modeNow !== "2d" || this.switching || !this.hasWorld) return;
    if (restingMode("2d", this.map.view.pixelsPerBlock, this.thresholdValues) === "3d")
      void this.enterWorld();
  }

  private loadWorldInfo(base: string, dimension: string): Promise<WorldInfo> {
    let info = this.worlds.get(dimension);
    if (info === undefined) {
      const url = new URL(`${base}/world.json`, location.href);
      url.searchParams.set("dimension", dimension);
      info = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`The 3D world could not be loaded (${response.status})`);
        return (await response.json()) as WorldInfo;
      });
      info.catch(() => this.worlds.delete(dimension));
      this.worlds.set(dimension, info);
    }
    return info;
  }

  private async enterWorld(): Promise<boolean> {
    const source = this.options.world;
    if (source === undefined || this.worldBroken || this.switching || this.disposed) return false;
    this.switching = true;
    const generation = ++this.generation;
    const dimension = this.map.dimension;
    let world: WorldViewer | undefined;
    try {
      this.worldModule ??= import("../three/world-viewer.js");
      const [module, info] = await Promise.all([
        this.worldModule,
        this.loadWorldInfo(source.base, dimension),
      ]);
      if (generation !== this.generation) return false;
      const start = this.mapTarget();
      this.worldLayer.style.visibility = "visible";
      world = await module.WorldViewer.create(
        this.worldLayer,
        info,
        cameraOverMap(start, Math.max(1, this.element.clientHeight)),
        {
          ...source.options,
          projection: this.projectionChoice,
          regionBase: `${source.base}/regions`,
          discoveryBase: `${source.base}/discoveries`,
        },
      );
      if (generation !== this.generation) return false;
      world.setPixelsPerBlock(start.pixelsPerBlock);
      await this.waitForTerrain(world, generation);
      if (generation !== this.generation) return false;
      // The map may have moved while the world loaded: start from where it is now.
      const now = this.mapTarget();
      world.setCameraView({ x: now.x, z: now.z, heading: 0, pitch: TOP_DOWN_PITCH });
      world.setPixelsPerBlock(now.pixelsPerBlock);
      this.worldViewer = world;
      world = undefined;
      this.modeNow = "3d";
      this.worldLayer.style.opacity = "1";
      this.worldLayer.style.pointerEvents = "";
      this.mapLayer.style.opacity = "0";
      this.mapLayer.style.pointerEvents = "none";
      this.mapLayer.inert = true;
      this.pointers.clear();
      this.poll = window.setInterval(() => this.watchWorld(), POLL_MS);
      this.moveFocus();
      this.options.onModeChange?.("3d");
      this.emit();
      if (this.autoTiltDegrees !== undefined)
        await this.turn(
          this.worldViewer,
          { pitch: tiltPitch(this.autoTiltDegrees) },
          TILT_MS,
          generation,
        );
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.worldBroken = true;
        this.hideWorldLayer();
        this.options.onWorldError?.(error);
      }
      return false;
    } finally {
      world?.dispose();
      if (this.modeNow === "2d" && this.worldViewer === undefined && generation === this.generation)
        this.hideWorldLayer();
      if (generation === this.generation) this.switching = false;
    }
  }

  /** The map view to hand to the 3D world: at least the switch scale. */
  private mapTarget(): MapView {
    const view = this.map.view;
    const pixelsPerBlock = Math.max(view.pixelsPerBlock, this.thresholdValues.toWorld);
    return { x: view.x, z: view.z, pixelsPerBlock };
  }

  private waitForTerrain(world: WorldViewer, generation: number): Promise<void> {
    const start = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const streaming = world.snapshot().streaming;
        if (
          generation !== this.generation ||
          (streaming.drawn > 0 && streaming.loading === 0) ||
          performance.now() - start > WORLD_READY_TIMEOUT
        )
          resolve();
        else setTimeout(check, 50);
      };
      check();
    });
  }

  private async leaveWorld(animate: boolean): Promise<void> {
    const world = this.worldViewer!;
    const generation = ++this.generation;
    this.switching = true;
    clearInterval(this.poll);
    if (animate) {
      const view = world.snapshot().view;
      await this.turn(
        world,
        { heading: view.heading - shortestHeading(view.heading), pitch: TOP_DOWN_PITCH },
        TURN_MS,
        generation,
      );
      if (generation !== this.generation) return;
    }
    const state = this.worldState(world);
    this.map.setView({ x: state.x, z: state.z, pixelsPerBlock: state.pixelsPerBlock }, false);
    this.modeNow = "2d";
    this.mapLayer.inert = false;
    this.mapLayer.style.pointerEvents = "";
    this.mapLayer.style.opacity = "1";
    this.worldLayer.style.opacity = "0";
    this.worldLayer.style.pointerEvents = "none";
    this.moveFocus();
    this.options.onModeChange?.("2d");
    this.emit();
    if (animate) await new Promise((resolve) => setTimeout(resolve, FADE_MS));
    world.dispose();
    if (this.worldViewer === world) this.worldViewer = undefined;
    if (generation === this.generation) {
      this.hideWorldLayer();
      this.switching = false;
    }
  }

  private hideWorldLayer(): void {
    this.worldLayer.style.opacity = "0";
    this.worldLayer.style.pointerEvents = "none";
    this.worldLayer.style.visibility = "hidden";
    this.mapLayer.style.opacity = "1";
    this.mapLayer.style.pointerEvents = "";
    this.mapLayer.inert = false;
  }

  /** Eases the camera heading and pitch; a new finger or a wheel turn stops it. */
  private turn(
    world: WorldViewer,
    to: { readonly heading?: number; readonly pitch?: number },
    duration: number,
    generation: number,
  ): Promise<void> {
    cancelAnimationFrame(this.tween);
    const from = world.snapshot().view;
    const start = performance.now();
    const pointersAtStart = this.pointers.size;
    const wheelAtStart = this.lastWheel;
    return new Promise((resolve) => {
      const step = (now: number) => {
        if (
          generation !== this.generation ||
          this.disposed ||
          this.pointers.size > pointersAtStart ||
          this.lastWheel !== wheelAtStart
        )
          return resolve();
        const t = Math.min(1, Math.max(0, (now - start) / duration));
        const k = easeInOut(t);
        world.setCameraView({
          heading: from.heading + ((to.heading ?? from.heading) - from.heading) * k,
          pitch: from.pitch + ((to.pitch ?? from.pitch) - from.pitch) * k,
        });
        this.emit();
        if (t < 1) this.tween = requestAnimationFrame(step);
        else resolve();
      };
      this.tween = requestAnimationFrame(step);
    });
  }

  /** Reports 3D view changes and returns to the map once the world rests below the map scale. */
  private watchWorld(): void {
    if (this.worldViewer === undefined || this.modeNow !== "3d") return;
    const before = this.lastState;
    this.emit();
    const state = this.lastState;
    const still =
      before.x === state.x &&
      before.z === state.z &&
      before.pixelsPerBlock === state.pixelsPerBlock &&
      before.heading === state.heading &&
      before.pitch === state.pitch;
    if (
      !this.switching &&
      still &&
      this.pointers.size === 0 &&
      performance.now() - this.lastWheel > WHEEL_REST_MS &&
      restingMode("3d", state.pixelsPerBlock, this.thresholdValues) === "2d"
    )
      void this.leaveWorld(true);
  }

  private readonly worldListeners: readonly [string, (event: Event) => void][] = [
    ["pointerdown", (event) => this.pointers.add((event as PointerEvent).pointerId)],
    ["pointerup", (event) => this.pointers.delete((event as PointerEvent).pointerId)],
    ["pointercancel", (event) => this.pointers.delete((event as PointerEvent).pointerId)],
    ["wheel", () => (this.lastWheel = performance.now())],
  ];
}

export type { Projection, SwitchThresholds, ViewMode, ViewState } from "./view-state.js";
