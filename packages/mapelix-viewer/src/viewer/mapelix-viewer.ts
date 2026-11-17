import { TileMap, type TileMapOptions } from "../map/tile-map.js";
import type { TileIndex } from "../map/tile-index.js";
import { blockAt, type MapView } from "../map/tile-math.js";
import {
  CAVE_LIMITS,
  contextSearch,
  DIMENSIONS,
  parseDimension,
  sceneContext,
  type SceneContext,
} from "@mapelix/scene-prototype/dimensions";
import {
  DEFAULT_DISCOVERY_FILTERS,
  DISCOVERY_KINDS,
  discoveryFilters,
  type DiscoveryFilters,
  type DiscoveryGroup,
} from "@mapelix/scene-prototype/discoveries";
import {
  horizontalSelection,
  selectionAround,
  type HorizontalSelection,
} from "@mapelix/scene-prototype/selection";
import type { VerticalMovement } from "../three/camera-rig.js";
import type { DepthNavigation } from "../three/depth-follow.js";
import type { DiscoveryDetailText } from "../three/discovery-focus.js";
import type { DiscoveryStats } from "../three/discovery-streamer.js";
import type { SelectionTool } from "../three/selection-box.js";
import type { AutoPerspective } from "../three/view-projection.js";
import type { WeatherMode } from "../three/weather-layer.js";
import type {
  LeafMode,
  TextureMode,
  TextureState,
  WorldInfo,
  WorldViewer,
  WorldViewerOptions,
} from "../three/world-viewer.js";
import { MarkerLayer, type MarkerTexts, type Markers } from "../markers/marker-layer.js";
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
  /** Further 3D options; what the viewer manages itself is left out. */
  readonly options?: Omit<
    WorldViewerOptions,
    | "projection"
    | "regionBase"
    | "discoveryBase"
    | "clouds"
    | "weather"
    | "autoDepth"
    | "loadDepth"
    | "onDepthChange"
    | "discoveryFilters"
    | "onDiscoverySelect"
    | "onDiscoveryFocusChange"
    | "discoveryDetails"
    | "selection"
    | "onSelectionChange"
    | "textures"
    | "leaves"
    | "textureBase"
    | "onTextureState"
  >;
}

/** What the 3D world shows. Kept while the map is on screen and applied when the world shows. */
export interface WorldSettings {
  /** Surface or a vertical cave slice; caves open the 3D world. */
  readonly viewMode: "surface" | "caves";
  /** Lowest Y of the cave slice, a multiple of 16. */
  readonly caveMinY: number;
  /** Cave slice thickness, 16 or 32 blocks. */
  readonly caveThickness: number;
  /** Height from which the Nether surface view hides terrain, a multiple of 16. */
  readonly netherCeilingY: number;
  /** Hour of the day from 0 to 24 (Overworld surface). */
  readonly hour: number;
  readonly clouds: boolean;
  readonly weather: WeatherMode;
  /** Block textures near the camera, when the server has them (default off). */
  readonly textures: TextureMode;
  /** Textured leaves and other cut-out blocks: fast (default) or detailed. */
  readonly leaves: LeafMode;
  /** Cave slices follow the camera depth. */
  readonly autoDepth: boolean;
  readonly discoveries: DiscoveryFilters;
  /** Cave exploration area. */
  readonly selection: HorizontalSelection | undefined;
  readonly selectionTool: SelectionTool;
}

export const DEFAULT_WORLD_SETTINGS: WorldSettings = {
  viewMode: "surface",
  caveMinY: 0,
  caveThickness: CAVE_LIMITS.defaultThickness,
  netherCeilingY: DIMENSIONS.nether.defaultCeilingY,
  hour: 15.5,
  clouds: true,
  weather: "clear",
  textures: "off",
  leaves: "fast",
  autoDepth: true,
  discoveries: DEFAULT_DISCOVERY_FILTERS,
  selection: undefined,
  selectionTool: "off",
};

/** Live state of the world for host controls. Texts are left to the host. */
export interface WorldStatus {
  /** A 3D world is configured and has not failed. */
  readonly available: boolean;
  /** The 3D world is on screen. */
  readonly shown: boolean;
  readonly name: string | undefined;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number } | undefined;
  /** Context of the 3D view, or the one the next 3D view opens with. */
  readonly context: SceneContext | undefined;
  /** A dimension, view or depth is loading. */
  readonly changing: boolean;
  /** 3D regions still to load. */
  readonly loading: number;
  readonly failure: string | undefined;
  /** A cave slice has loaded with no cave surface here. */
  readonly emptyCaves: boolean;
  /** Weather, clouds and time of day apply: Overworld surface. */
  readonly atmosphere: boolean;
  /**
   * Block textures: `off` as set, `unavailable` without a server texture stack, `loading`,
   * `on`, or `failed`, in which case the world keeps its block colors.
   */
  readonly textures: TextureState;
  readonly navigation: DepthNavigation | undefined;
  readonly discoveries: DiscoveryStats | undefined;
  readonly focusedDiscovery: DiscoveryGroup | undefined;
  /** The block under the pointer; `y` only in 3D. */
  readonly pointed: { readonly x: number; readonly y?: number; readonly z: number } | undefined;
}

export type ViewerListener = (
  view: ViewState,
  status: WorldStatus,
  settings: WorldSettings,
) => void;

export interface MapelixViewerOptions {
  readonly tiles: TileIndex;
  /** The 3D world behind the map; without it the viewer stays a 2D map. */
  readonly world?: WorldSource;
  readonly dimension?: string;
  readonly view?: Partial<MapView>;
  /** Scales at which the view changes mode (default: 3D above 5, map below 2 px/block). */
  readonly thresholds?: SwitchThresholds;
  /** 3D projection (default isometric). */
  readonly projection?: Projection;
  /**
   * Tilt the 3D camera to this many degrees above the horizon after it takes over from the map.
   * Off by default: the world first shows straight down, like the map.
   */
  readonly autoTilt?: number;
  /** Initial 3D settings. */
  readonly settings?: Partial<WorldSettings>;
  /** Extra 2D map options. */
  readonly map?: Pick<
    TileMapOptions,
    "minPixelsPerBlock" | "maxCachedTiles" | "maxRequests" | "background" | "onIdle"
  >;
  /** Accessible name of the view. */
  readonly label?: string;
  /** Texts of the marker layer (default English). */
  readonly markerTexts?: Partial<MarkerTexts>;
  /** Text of the discovery card (default English). */
  readonly formatDiscoveryDetails?: (group: DiscoveryGroup) => DiscoveryDetailText;
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
/** Scale the 3D view zooms to when caves open from the map. */
const CAVE_SCALE = 10;

type WorldModule = typeof import("../three/world-viewer.js");

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

function isWorldDimension(dimension: string): boolean {
  try {
    parseDimension(dimension);
    return true;
  } catch {
    return false;
  }
}

/**
 * One view of a world: a light 2D tile map that turns into the 3D world at the same center
 * and scale when zoomed in past `thresholds.toWorld`, and back into the map when zoomed out
 * below `thresholds.toMap`. The 3D engine loads only when first needed.
 *
 * Everything a host interface needs goes through this class: dimension, surface or caves,
 * weather, time, discoveries, going places. `subscribe` reports every change, so a host can use
 * the controls of `@mapelix/viewer/controls` or draw its own.
 */
export class MapelixViewer {
  readonly map: TileMap;
  /**
   * Host markers, drawn at the same place on the map and in 3D. Mapelix keeps no store: the host
   * gives the markers and listens to presses.
   */
  readonly markers: Markers;
  private readonly markerLayer: MarkerLayer;
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
  private settingsNow: WorldSettings;
  private info: WorldInfo | undefined;
  private contextGeneration = 0;
  private contextRequest: AbortController | undefined;
  private changing = false;
  private failure: string | undefined;
  private pointed: WorldStatus["pointed"];
  private pickEvent: PointerEvent | undefined;
  private focused: DiscoveryGroup | undefined;
  private readonly listeners = new Set<ViewerListener>();
  private publishQueued = false;

  constructor(element: HTMLElement, options: MapelixViewerOptions) {
    this.element = element;
    this.options = options;
    this.thresholdValues = checkThresholds(options.thresholds ?? DEFAULT_THRESHOLDS);
    this.projectionChoice = options.projection ?? "isometric";
    if (options.autoTilt !== undefined) tiltPitch(options.autoTilt);
    this.autoTiltDegrees = options.autoTilt;
    this.settingsNow = { ...DEFAULT_WORLD_SETTINGS, ...options.settings };
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
    element.addEventListener("pointermove", this.onPointerMove, { passive: true });
    element.addEventListener("pointerleave", this.onPointerLeave, { passive: true });
    this.worldLayer.addEventListener("keydown", this.onWorldKey);
    this.map = new TileMap(this.mapLayer, {
      ...options.map,
      index: options.tiles,
      dimension: options.dimension,
      view: options.view,
      maxPixelsPerBlock: MAP_MAX_SCALE,
      label: options.label,
      onRest: () => this.mapRested(),
      onViewChange: () => {
        this.emit();
        this.markerLayer?.redraw();
      },
    });
    this.markerLayer = new MarkerLayer(
      element,
      {
        mode: () => this.modeNow,
        dimension: () => this.map.dimension,
        project: (x, y, z, width, height, out) => {
          if (this.modeNow === "3d")
            return this.worldViewer?.projectToScreen(x, y, z, out) !== undefined;
          const view = this.map.view;
          out.x = width / 2 + (x - view.x) * view.pixelsPerBlock;
          out.y = height / 2 + (z - view.z) * view.pixelsPerBlock;
          return true;
        },
        heightAt: (x, z) => this.worldViewer?.surfaceHeightAt(x, z),
        zoomToward: (x, z) => this.zoomToward(x, z),
        isView: (target) =>
          target instanceof Node &&
          (this.mapLayer.contains(target) || this.worldLayer.contains(target)),
      },
      options.markerTexts,
    );
    this.markers = this.markerLayer;
    this.lastState = this.mapState();
    // A view that starts zoomed in past the switch scale, or in caves, opens in 3D.
    queueMicrotask(() => {
      if (this.settingsNow.viewMode === "caves") void this.enterWorld();
      else this.mapRested();
    });
  }

  /** The shared view: center, scale and, in 3D, the camera direction. */
  get view(): ViewState {
    return this.modeNow === "3d" && this.worldViewer !== undefined
      ? this.cameraState(this.worldViewer)
      : this.mapState();
  }

  get mode(): ViewMode {
    return this.modeNow;
  }

  get dimension(): string {
    return this.map.dimension;
  }

  /** Dimensions the viewer can show: those of the map, and every world dimension in 3D. */
  get dimensions(): string[] {
    const names = [...this.map.dimensions];
    if (this.hasWorld)
      for (const name of Object.keys(DIMENSIONS)) if (!names.includes(name)) names.push(name);
    return names;
  }

  /** The 3D viewer while it is shown, for hosts that use more of its API. */
  get world(): WorldViewer | undefined {
    return this.modeNow === "3d" ? this.worldViewer : undefined;
  }

  /** True when a 3D world is configured and has not failed. */
  get hasWorld(): boolean {
    return this.options.world !== undefined && !this.worldBroken;
  }

  get settings(): WorldSettings {
    return this.settingsNow;
  }

  get status(): WorldStatus {
    const world = this.modeNow === "3d" ? this.worldViewer : undefined;
    const snapshot = world?.snapshot();
    const context = snapshot?.context ?? this.safeContext();
    const streaming = snapshot?.streaming;
    return {
      available: this.hasWorld,
      shown: world !== undefined,
      name: this.info?.name,
      spawn: this.info?.spawn,
      context,
      changing: this.changing || (this.switching && this.modeNow === "2d"),
      loading: streaming?.remaining ?? 0,
      failure: this.failure,
      emptyCaves:
        context?.mode === "caves" &&
        streaming !== undefined &&
        streaming.cached > 0 &&
        streaming.remaining === 0 &&
        streaming.quads === 0,
      atmosphere: context?.dimension === "overworld" && context.mode === "surface",
      textures:
        (snapshot ?? this.worldViewer?.snapshot())?.textures.state ??
        (this.settingsNow.textures === "off"
          ? "off"
          : this.info !== undefined && this.info.textures === undefined
            ? "unavailable"
            : "loading"),
      navigation: snapshot?.navigation,
      discoveries: snapshot?.discoveries,
      focusedDiscovery: world === undefined ? undefined : this.focused,
      pointed: this.pointed,
    };
  }

  /** Calls `listener` now and after every change of the view, status or settings. */
  subscribe(listener: ViewerListener): () => void {
    this.listeners.add(listener);
    listener(this.view, this.status, this.settingsNow);
    return () => this.listeners.delete(listener);
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

  /** Rules that show perspective inside an isometric 3D view; undefined turns them off. */
  setAutoPerspective(rules: AutoPerspective | undefined): void {
    this.worldViewer?.setAutoPerspective(rules);
  }

  get autoTilt(): number | undefined {
    return this.autoTiltDegrees;
  }

  /** Degrees above the horizon to tilt to after switching to 3D; undefined turns it off. */
  setAutoTilt(degrees: number | undefined): void {
    if (degrees !== undefined) tiltPitch(degrees);
    this.autoTiltDegrees = degrees;
  }

  /** Shows another dimension at the same place, on the map or in 3D. */
  setDimension(dimension: string): void {
    if (dimension === this.map.dimension) return;
    this.map.setDimension(dimension);
    this.markerLayer.schedule();
    this.settingsNow = { ...this.settingsNow, viewMode: "surface" };
    this.focused = undefined;
    if (this.modeNow === "3d") {
      if (isWorldDimension(dimension)) void this.reloadWorld();
      else void this.showMap(false);
    } else if (this.switching) {
      // Drops a 3D world still loading for the previous dimension.
      this.generation++;
      this.switching = false;
      this.hideWorldLayer();
    }
    this.emit();
    this.publish();
  }

  /** Surface or caves. Caves need the 3D world, which opens if the map is shown. */
  setViewMode(mode: WorldSettings["viewMode"]): void {
    if (mode === "caves" && !this.hasWorld) return;
    this.updateSettings({ viewMode: mode });
    if (this.modeNow === "3d") void this.reloadWorld();
    else if (mode === "caves") void this.enterWorld(CAVE_SCALE);
  }

  /** Moves or resizes the cave slice; values snap to the dimension's 16-block grid. */
  setCaveSlice(minY: number, thickness = this.settingsNow.caveThickness): void {
    const config = DIMENSIONS[parseDimension(this.worldDimension())];
    const size = CAVE_LIMITS.thicknesses.includes(thickness)
      ? thickness
      : CAVE_LIMITS.defaultThickness;
    const lowest = Math.max(config.minY, Math.min(Math.round(minY / 16) * 16, config.maxY - size));
    this.updateSettings({ caveMinY: lowest, caveThickness: size });
    if (this.modeNow === "3d" && this.settingsNow.viewMode === "caves") void this.reloadWorld();
  }

  /** Hides Nether terrain from this height up, in the surface view. */
  setNetherCeiling(y: number): void {
    this.updateSettings({ netherCeilingY: Math.round(y / 16) * 16 });
    if (
      this.modeNow === "3d" &&
      this.settingsNow.viewMode === "surface" &&
      this.worldDimension() === "nether"
    )
      void this.reloadWorld();
  }

  setAutoDepth(enabled: boolean): void {
    this.updateSettings({ autoDepth: enabled });
    if (!this.changing) this.worldViewer?.setAutoDepth(enabled);
  }

  /** Held vertical movement in caves: 1 up, −1 down, 0 stop. */
  setVerticalMovement(direction: VerticalMovement): void {
    this.worldViewer?.setVerticalMovement(direction);
  }

  /** Brings a lost cave camera back above the slice. */
  recoverCamera(): void {
    this.updateSettings({ selectionTool: "off" });
    this.worldViewer?.setSelectionTool("off");
    this.worldViewer?.recoverCamera();
  }

  setTimeOfDay(hour: number): void {
    const value = ((hour % 24) + 24) % 24;
    this.updateSettings({ hour: value });
    this.worldViewer?.setTimeOfDay(value);
  }

  setClouds(enabled: boolean): void {
    this.updateSettings({ clouds: enabled });
    this.worldViewer?.setClouds(enabled);
  }

  /** Block textures near the camera; the status tells whether the server has them. */
  setTextures(mode: TextureMode): void {
    if (mode !== "off" && mode !== "on")
      throw new RangeError(`Unknown texture mode ${String(mode)}`);
    this.updateSettings({ textures: mode });
    this.worldViewer?.setTextures(mode);
  }

  /** Textured leaves fast, filled with a dark shade, or detailed, cut out with inner faces. */
  setLeaves(mode: LeafMode): void {
    if (mode !== "fast" && mode !== "detailed")
      throw new RangeError(`Unknown leaf mode ${String(mode)}`);
    this.updateSettings({ leaves: mode });
    this.worldViewer?.setLeaves(mode);
  }

  setWeather(weather: WeatherMode): void {
    this.updateSettings({ weather });
    this.worldViewer?.setWeather(weather);
  }

  /** Which discoveries show, in the 3D scene and the list; checked like the engine does. */
  setDiscoveryFilters(filters: Partial<DiscoveryFilters>): void {
    const next = discoveryFilters({ ...this.settingsNow.discoveries, ...filters });
    this.updateSettings({ discoveries: next });
    this.worldViewer?.setDiscoveryFilters(next);
  }

  /** Flies to a discovery, switching to its depth if needed. */
  async focusDiscovery(group: DiscoveryGroup): Promise<boolean> {
    const world = this.worldViewer;
    if (world === undefined || this.modeNow !== "3d") return false;
    const done = await world.focusDiscovery(group);
    if (done) this.syncFromWorld(world);
    this.publish();
    return done;
  }

  clearDiscoveryFocus(): void {
    this.worldViewer?.clearDiscoveryFocus();
    this.focused = undefined;
    this.publish();
  }

  /** The text of a discovery card, from the host formatter or the English default. */
  describeDiscovery(group: DiscoveryGroup): DiscoveryDetailText {
    if (this.options.formatDiscoveryDetails) return this.options.formatDiscoveryDetails(group);
    return {
      title: `${DISCOVERY_KINDS[group.kind]?.label ?? "Discovery"} × ${group.count}`,
      lines: [
        `X ${group.x} · Y ${group.y} · Z ${group.z}`,
        `${group.exposed} exposed · ${group.buried} buried · ${group.unknown} uncertain`,
      ],
      closeLabel: "Close discovery details",
    };
  }

  /** Limits cave exploration to an area; undefined clears it. */
  setSelection(selection: HorizontalSelection | undefined): void {
    const value = selection === undefined ? undefined : horizontalSelection(selection);
    this.updateSettings({ selection: value });
    this.worldViewer?.setSelection(value);
  }

  /** Selects the default area around the view center. */
  selectAroundView(): void {
    const view = this.view;
    this.setSelection(selectionAround(view.x, view.z));
  }

  setSelectionTool(tool: SelectionTool): void {
    this.updateSettings({ selectionTool: tool });
    this.worldViewer?.setSelectionTool(tool);
  }

  /** Moves the view to block `x`, `z`, keeping the mode and scale. */
  goTo(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.modeNow === "3d" && this.worldViewer !== undefined) this.worldViewer.flyTo(x, z);
    else this.map.setView({ x, z });
  }

  /** Goes to the world spawn, or to the start view without a world. */
  async goHome(): Promise<void> {
    const source = this.options.world;
    if (source !== undefined && this.hasWorld && isWorldDimension(this.worldDimension())) {
      try {
        const info = this.info ?? (await this.loadWorldInfo(source.base, this.surfaceContext()));
        this.goTo(info.spawn.x, info.spawn.z);
        return;
      } catch {
        /* Falls back to the start view. */
      }
    }
    this.goTo(this.options.view?.x ?? 0, this.options.view?.z ?? 0);
  }

  /** Turns the 3D camera to face north. */
  faceNorth(): void {
    this.worldViewer?.faceNorth();
    this.emit();
  }

  /**
   * Gives the keyboard focus to the view shown: arrows and +/− on the map; WASD, arrows, Q/E,
   * R/F, +/− and Space/C in 3D. Hosts call it after a pointer press on their own
   * controls, so a focused button never takes those keys.
   */
  focus(): void {
    this.focusTarget()?.focus({ preventScroll: true });
  }

  /**
   * The block under a screen point: on the map its X and Z, in 3D the first drawn block along
   * the pointer ray (with Y). `undefined` in 3D where no terrain is drawn.
   */
  pickBlock(clientX: number, clientY: number): { x: number; y?: number; z: number } | undefined {
    if (this.modeNow === "3d" && this.worldViewer !== undefined)
      return this.worldViewer.pick(clientX, clientY);
    const bounds = this.element.getBoundingClientRect();
    const block = blockAt(
      this.map.view,
      bounds.width,
      bounds.height,
      clientX - bounds.left,
      clientY - bounds.top,
    );
    return { x: Math.floor(block.x), z: Math.floor(block.z) };
  }

  /** Centers a world point and zooms in twice, in either mode (a press on a marker group). */
  zoomToward(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (this.modeNow === "3d" && this.worldViewer !== undefined) {
      this.worldViewer.flyTo(x + 0.5, z + 0.5);
      this.worldViewer.zoom(0.5);
    } else
      this.map.setView({
        x: x + 0.5,
        z: z + 0.5,
        pixelsPerBlock: this.map.view.pixelsPerBlock * 2,
      });
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
    this.contextRequest?.abort();
    cancelAnimationFrame(this.tween);
    clearInterval(this.poll);
    this.worldViewer?.dispose();
    this.worldViewer = undefined;
    this.listeners.clear();
    this.markerLayer.dispose();
    this.element.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.element.removeEventListener("pointerleave", this.onPointerLeave);
    this.map.dispose();
    this.mapLayer.remove();
    this.worldLayer.remove();
  }

  private updateSettings(change: Partial<WorldSettings>): void {
    this.settingsNow = { ...this.settingsNow, ...change };
    this.publish();
  }

  /** The 3D dimension for the map's dimension (the map may hold others). */
  private worldDimension(): string {
    return this.map.dimension;
  }

  private surfaceContext(): SceneContext {
    const dimension = parseDimension(this.worldDimension());
    return dimension === "nether"
      ? sceneContext(dimension, this.settingsNow.netherCeilingY)
      : sceneContext(dimension);
  }

  /** The context the settings ask for in the map's dimension. */
  private requestedContext(): SceneContext {
    const { viewMode, caveMinY, caveThickness } = this.settingsNow;
    if (viewMode === "surface") return this.surfaceContext();
    const dimension = parseDimension(this.worldDimension());
    const config = DIMENSIONS[dimension];
    const minY = Math.max(config.minY, Math.min(caveMinY, config.maxY - caveThickness));
    return sceneContext(dimension, { mode: "caves", minY, maxY: minY + caveThickness });
  }

  private safeContext(): SceneContext | undefined {
    if (!this.hasWorld || !isWorldDimension(this.worldDimension())) return undefined;
    try {
      return this.requestedContext();
    } catch {
      return undefined;
    }
  }

  /** Loads the context the settings ask for into the 3D viewer, keeping the view. */
  private async reloadWorld(): Promise<void> {
    const world = this.worldViewer;
    const source = this.options.world;
    if (world === undefined || source === undefined) return;
    const id = ++this.contextGeneration;
    this.contextRequest?.abort();
    const request = (this.contextRequest = new AbortController());
    this.changing = true;
    this.failure = undefined;
    world.setAutoDepth(false);
    this.publish();
    try {
      const context = this.requestedContext();
      const info = await this.loadWorldInfo(source.base, context, request.signal);
      if (id !== this.contextGeneration || this.worldViewer !== world) return;
      const sameDimension = this.info?.dimension === info.dimension;
      world.setWorld(info, true);
      if (!sameDimension) world.setSelection(this.settingsNow.selection);
      this.info = info;
      this.focused = undefined;
      this.syncFromWorld(world);
    } catch (cause) {
      if (id !== this.contextGeneration || request.signal.aborted) return;
      this.failure = cause instanceof Error ? cause.message : String(cause);
      // The settings follow what is still shown.
      this.syncFromWorld(world);
    } finally {
      if (id === this.contextGeneration) {
        this.changing = false;
        world.setAutoDepth(this.settingsNow.autoDepth);
        this.publish();
      }
    }
  }

  /** Follows context changes the engine made itself: depth following, discovery focus. */
  private syncFromWorld(world: WorldViewer): void {
    if (this.changing) return;
    const snapshot = world.snapshot();
    this.syncContext(snapshot.context);
    if (snapshot.selection !== this.settingsNow.selection)
      this.settingsNow = { ...this.settingsNow, selection: snapshot.selection };
  }

  private syncContext(context: SceneContext): void {
    const change: Partial<{ -readonly [K in keyof WorldSettings]: WorldSettings[K] }> = {
      viewMode: context.mode,
    };
    if (context.mode === "caves") {
      change.caveMinY = context.minY;
      change.caveThickness = context.maxY - context.minY;
    } else if (context.dimension === "nether") change.netherCeilingY = context.maxY;
    const next = { ...this.settingsNow, ...change };
    if (
      next.viewMode !== this.settingsNow.viewMode ||
      next.caveMinY !== this.settingsNow.caveMinY ||
      next.caveThickness !== this.settingsNow.caveThickness ||
      next.netherCeilingY !== this.settingsNow.netherCeilingY
    ) {
      this.settingsNow = next;
      this.publish();
    }
  }

  /** Reports to subscribers once per task, however many changes it made. */
  private publish(): void {
    if (this.publishQueued || this.listeners.size === 0) return;
    this.publishQueued = true;
    queueMicrotask(() => {
      this.publishQueued = false;
      if (this.disposed) return;
      const view = this.view,
        status = this.status;
      for (const listener of this.listeners) listener(view, status, this.settingsNow);
    });
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

  /** The block under a mouse pointer, at most once per frame (3D picking marches a ray). */
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse") return;
    if (this.pickEvent === undefined)
      requestAnimationFrame(() => {
        const pending = this.pickEvent;
        this.pickEvent = undefined;
        if (pending === undefined || this.disposed) return;
        const bounds = this.element.getBoundingClientRect();
        if (this.modeNow === "3d" && this.worldViewer !== undefined)
          this.pointed = this.worldViewer.pick(pending.clientX, pending.clientY);
        else {
          const block = blockAt(
            this.map.view,
            bounds.width,
            bounds.height,
            pending.clientX - bounds.left,
            pending.clientY - bounds.top,
          );
          this.pointed = { x: Math.floor(block.x), z: Math.floor(block.z) };
        }
        this.publish();
      });
    this.pickEvent = event;
  };

  private readonly onPointerLeave = (): void => {
    this.pickEvent = undefined;
    if (this.pointed === undefined) return;
    this.pointed = undefined;
    this.publish();
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

  private cameraState(world: WorldViewer): ViewState {
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
    ) {
      this.options.onViewChange?.(state);
      this.publish();
    }
  }

  private mapRested(): void {
    if (this.modeNow !== "2d" || this.switching || !this.hasWorld) return;
    if (!isWorldDimension(this.worldDimension())) return;
    if (restingMode("2d", this.map.view.pixelsPerBlock, this.thresholdValues) === "3d")
      void this.enterWorld();
  }

  private loadWorldInfo(
    base: string,
    context: SceneContext,
    signal?: AbortSignal,
  ): Promise<WorldInfo> {
    const search = contextSearch(context).toString();
    let info = this.worlds.get(search);
    if (info === undefined) {
      const url = new URL(`${base}/world.json?${search}`, location.href);
      info = fetch(url, { signal }).then(async (response) => {
        if (!response.ok) throw new Error(`The 3D world could not be loaded (${response.status})`);
        return (await response.json()) as WorldInfo;
      });
      // Only surfaces are kept: cave metadata follows each slice.
      if (context.mode === "surface") {
        this.worlds.set(search, info);
        info.catch(() => this.worlds.delete(search));
      }
    }
    return info;
  }

  private async enterWorld(minimumScale = 0): Promise<boolean> {
    const source = this.options.world;
    if (source === undefined || this.worldBroken || this.switching || this.disposed) return false;
    if (!isWorldDimension(this.worldDimension())) return false;
    this.switching = true;
    this.publish();
    const generation = ++this.generation;
    let world: WorldViewer | undefined;
    try {
      this.worldModule ??= import("../three/world-viewer.js");
      const [module, info] = await Promise.all([
        this.worldModule,
        this.loadWorldInfo(source.base, this.requestedContext()),
      ]);
      if (generation !== this.generation) return false;
      const start = this.mapTarget(minimumScale);
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
          clouds: this.settingsNow.clouds,
          weather: this.settingsNow.weather,
          textures: this.settingsNow.textures,
          leaves: this.settingsNow.leaves,
          textureBase: `${source.base}/textures`,
          onTextureState: () => this.publish(),
          autoDepth: this.settingsNow.autoDepth,
          discoveryFilters: this.settingsNow.discoveries,
          ...(this.settingsNow.selection ? { selection: this.settingsNow.selection } : {}),
          // The host draws the discovery card where its controls leave room.
          discoveryDetails: false,
          loadDepth: (context, signal) => this.loadWorldInfo(source.base, context, signal),
          onDepthChange: (context) => this.syncContext(context),
          onDiscoverySelect: (group) => void this.focusDiscovery(group),
          onDiscoveryFocusChange: (group) => {
            this.focused = group;
            this.publish();
          },
          onSelectionChange: (change) => {
            this.settingsNow = { ...this.settingsNow, selection: change.selection };
            if (change.minY !== this.settingsNow.caveMinY) this.setCaveSlice(change.minY);
            this.publish();
          },
        },
      );
      if (generation !== this.generation) return false;
      world.setPixelsPerBlock(start.pixelsPerBlock);
      world.setTimeOfDay(this.settingsNow.hour);
      world.setSelectionTool(this.settingsNow.selectionTool);
      this.info = info;
      this.failure = undefined;
      await this.waitForTerrain(world, generation);
      if (generation !== this.generation) return false;
      // The map may have moved while the world loaded: start from where it is now.
      const now = this.mapTarget(minimumScale);
      world.setCameraView({ x: now.x, z: now.z, heading: 0, pitch: TOP_DOWN_PITCH });
      world.setPixelsPerBlock(now.pixelsPerBlock);
      this.worldViewer = world;
      world.onFrame(() => this.markerLayer.redraw());
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
      this.publish();
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
        this.failure = error instanceof Error ? error.message : String(error);
        this.hideWorldLayer();
        this.options.onWorldError?.(error);
      }
      return false;
    } finally {
      world?.dispose();
      if (this.modeNow === "2d" && this.worldViewer === undefined && generation === this.generation)
        this.hideWorldLayer();
      if (generation === this.generation) this.switching = false;
      this.publish();
    }
  }

  /** The map view to hand to the 3D world: at least the switch scale. */
  private mapTarget(minimumScale: number): MapView {
    const view = this.map.view;
    const pixelsPerBlock = Math.max(
      view.pixelsPerBlock,
      this.thresholdValues.toWorld,
      minimumScale,
    );
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
    this.contextGeneration++;
    this.contextRequest?.abort();
    this.changing = false;
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
    const state = this.cameraState(world);
    // The map shows the surface: the next 3D view opens there too.
    this.settingsNow = { ...this.settingsNow, viewMode: "surface" };
    this.focused = undefined;
    this.pointed = undefined;
    this.map.setView({ x: state.x, z: state.z, pixelsPerBlock: state.pixelsPerBlock }, false);
    this.modeNow = "2d";
    this.markerLayer.schedule();
    this.mapLayer.inert = false;
    this.mapLayer.style.pointerEvents = "";
    this.mapLayer.style.opacity = "1";
    this.worldLayer.style.opacity = "0";
    this.worldLayer.style.pointerEvents = "none";
    this.moveFocus();
    this.options.onModeChange?.("2d");
    this.emit();
    this.publish();
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

  /** Reports 3D changes and returns to the map once the world rests below the map scale. */
  private watchWorld(): void {
    if (this.worldViewer === undefined || this.modeNow !== "3d") return;
    this.syncFromWorld(this.worldViewer);
    this.publish();
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
      !this.changing &&
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
