import {
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  PCFShadowMap,
  RenderPipeline,
  Scene,
  Timer,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { normalWorldGeometry, pass } from "three/tsl";
import { retainScreenUniforms } from "./shaders/stable-screen";
import { createStablePCFFilter } from "./shaders/shadow-filter";
import { SelectionBox, type SelectionTool, type SelectionChange } from "./selection-box";
import { horizontalSelection, type HorizontalSelection } from "@mapelix/scene-prototype/selection";
import { DiscoveryStreamer, type DiscoveryStats } from "./discovery-streamer";
import {
  DISCOVERY_KINDS,
  type DiscoveryFilters,
  type DiscoveryGroup,
} from "@mapelix/scene-prototype/discoveries";

import { Atmosphere } from "./atmosphere";
import { CloudLayer } from "./cloud-layer";
import { WeatherLayer, weatherMode, type WeatherMode } from "./weather-layer";
import {
  CameraRig,
  ZOOM_LIMIT,
  pointerRay,
  type CameraView,
  type VerticalMovement,
} from "./camera-rig";
import { DepthFollow, type DepthNavigation } from "./depth-follow";
import { ExplorationRequests } from "./exploration-requests";
import { DiscoveryDetails } from "./discovery-details";
import type { DiscoveryLabelFormatter } from "./discovery-label";
import { discoveryContext, discoveryDistance, type DiscoveryDetailText } from "./discovery-focus";
import { RegionStreamer, type StreamingStats } from "./region-streamer";
import { RegionMeshPool } from "./region-mesh";
import {
  PROJECTION_TRANSITION_SECONDS,
  ViewCamera,
  distanceForPixelsPerBlock,
  easeProjection,
  effectiveProjection,
  pixelsPerBlock,
  rayReach,
  type AutoPerspective,
  type ViewProjection,
} from "./view-projection";
import { createSceneMaterials, type SceneMaterials } from "./shaders/materials";
import {
  CAVE_LIMITS,
  DIMENSIONS,
  sceneContext,
  contextKey,
  type SceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";

export interface WorldInfo extends SceneContextInput {
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly revision: string;
  readonly snapshotRevision?: string;
  readonly discoveries?: { readonly schemaVersion: number; readonly tileSpan: number };
}

export type { CameraView, VerticalMovement } from "./camera-rig";
export type { DiscoveryDetailText } from "./discovery-focus";
export type { WeatherMode } from "./weather-layer";
export type { AutoPerspective, ViewProjection } from "./view-projection";

/** Kept across view switches so embedding does not fall back to a different server. */
export interface WorldViewerOptions {
  /** Animated block clouds in Overworld Surface views (default true). */
  readonly clouds?: boolean;
  /** Cosmetic Overworld Surface weather only, independent of the server (default clear). */
  readonly weather?: WeatherMode;
  /** Host metadata loader for depth/discovery transitions; retains host URL/authentication. */
  readonly loadDepth?: (context: SceneContext, signal: AbortSignal) => Promise<WorldInfo>;
  /** Emitted after automatic depth or discovery navigation changes context. */
  readonly onDepthChange?: (context: SceneContext) => void;
  readonly autoDepth?: boolean;
  /** Minimum time between automatic slice requests, at least 1000 ms (default 2000). */
  readonly autoDepthIntervalMs?: number;
  readonly regionBase?: string;
  readonly regionSuffix?: string;
  readonly caveViewDistance?: number;
  readonly caveMemoryBudget?: number;
  readonly selection?: HorizontalSelection;
  readonly onSelectionChange?: (change: SelectionChange) => void;
  readonly discoveryBase?: string;
  readonly discoverySuffix?: string;
  readonly discoveryMemoryBudget?: number;
  readonly discoveryFilters?: DiscoveryFilters;
  readonly onDiscoverySelect?: (discovery: DiscoveryGroup) => void;
  readonly discoveryDetails?: boolean;
  readonly formatDiscoveryDetails?: (discovery: DiscoveryGroup) => DiscoveryDetailText;
  /** Shared accessible name and immediate hover/focus label; defaults to English. */
  readonly formatDiscoveryLabel?: DiscoveryLabelFormatter;
  readonly onDiscoveryFocusChange?: (discovery: DiscoveryGroup | undefined) => void;
  /** Initial projection (default perspective). */
  readonly projection?: ViewProjection;
  /** Rules that show perspective inside an isometric view (default none). */
  readonly autoPerspective?: AutoPerspective;
}

export interface ProjectionState {
  /** The projection picked by the viewer's host. */
  readonly chosen: ViewProjection;
  /** The projection shown, after any automatic perspective rule. */
  readonly shown: ViewProjection;
  /** Orthographic share of the projection now, from 0 to 1; in between during a transition. */
  readonly blend: number;
  /** CSS pixels covered by one block on the plane through the camera focus. */
  readonly pixelsPerBlock: number;
}

export interface ViewerSnapshot {
  readonly backend: "WebGPU" | "WebGL 2";
  readonly framesPerSecond: number;
  readonly view: CameraView;
  readonly streaming: StreamingStats;
  readonly context: SceneContext;
  readonly selection: HorizontalSelection | undefined;
  readonly discoveries: DiscoveryStats;
  readonly navigation: DepthNavigation;
  readonly selectedDiscovery: DiscoveryGroup | undefined;
  readonly projection: ProjectionState;
}

export interface Pointed {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const SHADOW_MAP_SIZE = 4096;
/** Half the width of the sun's shadow map when zoomed far out, in blocks. */
const MAX_SHADOW_EXTENT = 2048;
const MAX_PIXEL_RATIO = 1.75;
/** Farthest the view grows on its own as the camera zooms out, in blocks. */
const AUTO_VIEW_LIMIT = 32_768;

/**
 * The 3D world view: renderer, lights, atmosphere, streaming, and camera. It
 * redraws continuously for water and plants, but refreshes the sun's shadow map
 * only when the view, the sun, or the loaded terrain changes.
 */
export class WorldViewer {
  private readonly container: HTMLElement;
  private readonly renderer: WebGPURenderer;
  private readonly pipeline: RenderPipeline;
  private readonly glow: ReturnType<typeof bloom>;
  private readonly scene = new Scene();
  private readonly camera = new ViewCamera(50, 1, 1, 12000);
  private readonly atmosphere = new Atmosphere();
  private readonly clouds: CloudLayer;
  private readonly weather: WeatherLayer;
  private sunIntensity = 3;
  private skyIntensity = 2.6;
  private readonly sun = new DirectionalLight(0xffffff, 3);
  private readonly sky = new HemisphereLight(0xb9d3ec, 0x8a7a62, 1.4);
  private streamer: RegionStreamer;
  private readonly materials: SceneMaterials;
  private readonly meshPool = new RegionMeshPool();
  private readonly options: WorldViewerOptions;
  private readonly selectionBox: SelectionBox;
  private readonly selections = new Map<string, HorizontalSelection>();
  private readonly discoveries: DiscoveryStreamer;
  private context: SceneContext;
  private caveThickness: number = CAVE_LIMITS.defaultThickness;
  private world: WorldInfo;
  private readonly depthFollow: DepthFollow<WorldInfo>;
  private readonly explorationRequests = new ExplorationRequests(2);
  private readonly discoveryDetails: DiscoveryDetails;
  private selectedDiscovery: DiscoveryGroup | undefined;
  private discoveryRequest: AbortController | undefined;
  private refineDiscovery = false;
  private hour = 15.5;
  private readonly rig: CameraRig;
  private readonly timer = new Timer();
  private readonly resizeObserver: ResizeObserver;
  private readonly sunDirection = new Vector3(0.4, 0.7, 0.3);
  private readonly rainOrigin = new Vector3();
  private shadowKey = "";
  private regionsChanged = true;
  /** A fixed render distance in blocks, or undefined to follow the zoom. */
  private renderDistance: number | undefined;
  private frames = 0;
  private frameWindowStart = performance.now();
  private framesPerSecond = 0;
  private projectionChoice: ViewProjection = "perspective";
  private projectionShown: ViewProjection = "perspective";
  private autoPerspective: AutoPerspective | undefined;
  /** Blend at the start of the running transition, and how far it has run, from 0 to 1. */
  private projectionFrom = 0;
  private projectionProgress = 1;

  private constructor(
    container: HTMLElement,
    world: WorldInfo,
    renderer: WebGPURenderer,
    start: Partial<CameraView>,
    options: WorldViewerOptions,
  ) {
    this.container = container;
    this.world = world;
    this.context = sceneContext(world.dimension, world);
    if (this.context.mode === "caves") this.caveThickness = this.context.maxY - this.context.minY;
    this.options = options;
    this.depthFollow = new DepthFollow(
      options.loadDepth,
      (next) => {
        if (
          (next.snapshotRevision ?? next.revision) !==
          (this.world.snapshotRevision ?? this.world.revision)
        )
          throw new Error("The world snapshot changed; reopen the view before continuing");
        this.applyWorld(next, true, true);
        options.onDepthChange?.(this.context);
      },
      options.autoDepth,
      options.autoDepthIntervalMs,
    );
    this.atmosphere.setDimension(world.dimension);
    this.atmosphere.setCaves(this.context.mode === "caves");
    this.clouds = new CloudLayer(this.atmosphere, options.clouds);
    this.clouds.setContext(this.context);
    this.weather = new WeatherLayer(this.atmosphere, options.weather);
    this.weather.setContext(this.context);
    this.renderer = renderer;
    container.append(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute("aria-label", "3D world view");

    retainScreenUniforms();
    this.selectionBox = new SelectionBox(
      this.camera,
      renderer.domElement,
      this.context,
      (change) => {
        this.setSelection(change.selection);
        this.options.onSelectionChange?.(change);
      },
      (dragging) => {
        if (dragging) this.clearDiscoveryFocus();
        this.rig?.setEnabled(!dragging);
      },
    );
    this.materials = createSceneMaterials(this.atmosphere, this.selectionBox.mask);
    this.streamer = this.createStreamer(world);
    this.scene.add(this.streamer.root, this.sky, this.sun, this.sun.target, this.selectionBox.root);
    this.scene.add(this.clouds.root);
    this.scene.add(this.weather.root);
    this.scene.backgroundNode = this.atmosphere.sky(normalWorldGeometry);
    this.scene.fogNode = this.atmosphere.fogNode;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.autoUpdate = false;
    // Public WebGPU LightShadow hook omitted by Three's shared shadow typings.
    Object.assign(this.sun.shadow, { filterNode: createStablePCFFilter(this.sun.shadow) });

    this.rig = new CameraRig(
      this.camera,
      renderer.domElement,
      {
        heightAt: (x, z) =>
          this.context.mode === "caves" ? undefined : this.streamer.heightAt(x, z),
        raycast: (origin, direction, far, radius) =>
          this.streamer.raycast(origin, direction, far, radius),
      },
      (action) => {
        if (action !== "rotate") this.clearDiscoveryFocus();
      },
    );
    this.discoveryDetails = new DiscoveryDetails(
      container,
      () => this.clearDiscoveryFocus(),
      options.formatDiscoveryDetails,
      options.discoveryDetails,
    );
    this.rig.setVerticalWindow(this.context.mode === "caves" ? this.context : undefined);
    this.discoveries = new DiscoveryStreamer(container, {
      explorationRequests: this.explorationRequests,
      isSurfaceBlock: (x, y, z, kind) =>
        DISCOVERY_KINDS[kind]?.category === "containers"
          ? this.streamer.isRenderedSurfaceBlock(x, y, z)
          : this.streamer.isSurfaceBlock(x, y, z),
      onPointerSelect: () => renderer.domElement.focus({ preventScroll: true }),
      ...(options.formatDiscoveryLabel === undefined
        ? {}
        : { formatDiscoveryLabel: options.formatDiscoveryLabel }),
      ...(options.discoveryBase === undefined ? {} : { base: options.discoveryBase }),
      ...(options.discoverySuffix === undefined ? {} : { suffix: options.discoverySuffix }),
      ...(options.discoveryMemoryBudget === undefined
        ? {}
        : { memoryBudget: options.discoveryMemoryBudget }),
      onselect: (group) =>
        options.onDiscoverySelect
          ? options.onDiscoverySelect(group)
          : void this.focusDiscovery(group),
    });
    this.discoveries.setWorld(world);
    if (options.discoveryFilters) this.discoveries.setFilters(options.discoveryFilters);
    this.rig.setView(
      {
        x: world.spawn.x,
        y:
          this.context.mode === "caves"
            ? (this.context.minY + this.context.maxY) / 2
            : world.spawn.y,
        z: world.spawn.z,
        distance: this.context.mode === "caves" || world.dimension === "nether" ? 80 : 160,
        heading: MathUtils.degToRad(35),
        pitch: MathUtils.degToRad(42),
        ...start,
      },
      { settle: this.context.mode !== "caves" && start.y === undefined },
    );
    this.setSelection(options.selection);
    this.autoPerspective = options.autoPerspective;
    this.setProjection(options.projection ?? "perspective", false);

    // Only very bright light blooms: the sun, glints on water, and lamps after dark.
    const color = pass(this.scene, this.camera, { samples: 4 }).getTextureNode("output");
    this.glow = bloom(color, 0.5, 0.45, 1.4);
    this.pipeline = new RenderPipeline(renderer);
    this.pipeline.outputNode = color.add(this.glow);
    this.setTimeOfDay(15.5);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.timer.connect(document);
    renderer.setAnimationLoop(() => this.frame());
  }

  static async create(
    container: HTMLElement,
    world: WorldInfo,
    start: Partial<CameraView> = {},
    options: WorldViewerOptions = {},
  ): Promise<WorldViewer> {
    if (options.weather !== undefined) weatherMode(options.weather);
    if (options.selection) horizontalSelection(options.selection);
    if (
      options.autoDepthIntervalMs !== undefined &&
      (!Number.isFinite(options.autoDepthIntervalMs) || options.autoDepthIntervalMs < 1000)
    )
      throw new RangeError("Automatic depth interval must be at least 1000 ms");
    if (
      options.discoveryMemoryBudget !== undefined &&
      (!Number.isFinite(options.discoveryMemoryBudget) || options.discoveryMemoryBudget < 32)
    )
      throw new RangeError("Discovery memory budget must be at least 32 bytes");
    for (const value of [options.caveViewDistance, options.caveMemoryBudget]) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0))
        throw new RangeError("Cave budgets must be positive");
    }
    const renderer = new WebGPURenderer({
      antialias: false,
      powerPreference: "high-performance",
      reversedDepthBuffer: false,
    });
    await renderer.init();
    renderer.toneMapping = NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    return new WorldViewer(container, world, renderer, start, options);
  }

  get backend(): ViewerSnapshot["backend"] {
    return "isWebGPUBackend" in this.renderer.backend ? "WebGPU" : "WebGL 2";
  }

  snapshot(): ViewerSnapshot {
    const focus = this.rig.focus;
    return {
      backend: this.backend,
      framesPerSecond: this.framesPerSecond,
      view: {
        x: focus.x,
        y: focus.y,
        z: focus.z,
        distance: this.rig.distance,
        heading: this.rig.heading,
        pitch: this.rig.pitch,
      },
      streaming: this.streamer.stats,
      context: this.context,
      selection: this.selections.get(this.context.dimension),
      discoveries: this.discoveries.stats,
      navigation: this.depthFollow.state,
      selectedDiscovery: this.selectedDiscovery,
      projection: {
        chosen: this.projectionChoice,
        shown: this.projectionShown,
        blend: this.camera.projectionBlend,
        pixelsPerBlock: this.focusPixelsPerBlock(),
      },
    };
  }

  /** Picks perspective or isometric; the change animates unless `animate` is false. */
  setProjection(projection: ViewProjection, animate = true): void {
    this.projectionChoice = projection;
    this.updateProjectionTarget(animate);
  }

  /** Rules that show perspective inside an isometric view; undefined turns them off. */
  setAutoPerspective(rules: AutoPerspective | undefined): void {
    this.autoPerspective = rules;
    this.updateProjectionTarget(true);
  }

  /** Places the camera; fields left out keep their current value. */
  setCameraView(view: Partial<CameraView>): void {
    this.rig.setView({ ...this.snapshot().view, ...view }, { settle: false });
    this.fitViewDistance();
  }

  /** Tilts the camera to `pitch` radians above the horizon, keeping the focus and zoom. */
  setPitch(pitch: number): void {
    this.rig.setView({ ...this.snapshot().view, pitch }, { settle: false });
    this.fitViewDistance();
  }

  /** Zooms so that one block covers `pixels` CSS pixels on the plane through the focus. */
  setPixelsPerBlock(pixels: number): void {
    const distance = distanceForPixelsPerBlock(pixels, this.camera.fov, this.cssHeight);
    this.rig.setView({ ...this.snapshot().view, distance }, { settle: false });
    this.fitViewDistance();
  }

  /** Hour of the day from 0 to 24. Noon is 12. */
  setTimeOfDay(hour: number): void {
    this.hour = hour;
    const daylight = this.atmosphere.setTimeOfDay(hour);
    this.sun.color.copy(daylight.sunColor);
    this.sunIntensity = daylight.sunIntensity;
    this.sky.color.copy(daylight.skyColor);
    this.sky.groundColor.copy(daylight.groundColor);
    this.skyIntensity = daylight.ambientIntensity * 3.1;
    this.applyWeatherLighting();
    this.sunDirection.copy(daylight.direction);
    this.glow.strength.value = MathUtils.lerp(0.9, 0.45, daylight.daylight);
    this.shadowKey = "";
  }

  /** Replaces all terrain together while retaining the renderer, materials and controls. */
  setWorld(world: WorldInfo, keepView = false): void {
    this.clearDiscoveryFocus();
    this.depthFollow.cancel();
    this.applyWorld(world, keepView);
  }

  private applyWorld(world: WorldInfo, keepView: boolean, followDepth = false): void {
    // Validate before releasing the current terrain.
    const context = sceneContext(world.dimension, world);
    const previous = this.snapshot().view;
    this.scene.remove(this.streamer.root);
    this.streamer.dispose();
    this.world = world;
    this.context = context;
    if (context.mode === "caves") this.caveThickness = context.maxY - context.minY;
    this.discoveries.setWorld(world);
    this.streamer = this.createStreamer(world);
    this.scene.add(this.streamer.root);
    this.atmosphere.setDimension(world.dimension);
    this.atmosphere.setCaves(this.context.mode === "caves");
    this.clouds.setContext(this.context);
    this.weather.setContext(this.context);
    this.setTimeOfDay(this.hour);
    this.rig.setVerticalWindow(
      this.context.mode === "caves" ? this.context : undefined,
      followDepth,
    );
    this.rig.setView(
      {
        ...previous,
        ...(keepView ? {} : { ...world.spawn, distance: world.dimension === "nether" ? 80 : 160 }),
        ...(this.context.mode === "caves" && !followDepth
          ? {
              y: (this.context.minY + this.context.maxY) / 2,
              distance: Math.min(previous.distance, 80),
            }
          : {}),
      },
      { settle: this.context.mode !== "caves" },
    );
    this.setSelection(this.selections.get(this.context.dimension));
    this.regionsChanged = true;
    this.fitViewDistance();
  }

  private createStreamer(world: WorldInfo): RegionStreamer {
    const caves = this.context.mode === "caves";
    return new RegionStreamer({
      context: this.context,
      revision: world.revision,
      ...(this.options.regionBase === undefined ? {} : { regionBase: this.options.regionBase }),
      ...(this.options.regionSuffix === undefined
        ? {}
        : { regionSuffix: this.options.regionSuffix }),
      meshPool: this.meshPool,
      ...(caves ? { explorationRequests: this.explorationRequests } : {}),
      materials: this.materials,
      voxelPixels: 2.2,
      blockPixels: 4.4,
      viewDistance: caves
        ? (this.options.caveViewDistance ?? CAVE_LIMITS.viewDistance)
        : this.atmosphere.viewDistance.value,
      maxRequests: caves ? 2 : 10,
      memoryBudget: caves
        ? (this.options.caveMemoryBudget ?? CAVE_LIMITS.memoryBudget)
        : 1024 * 1024 * 1024,
      onRegion: () => {
        this.regionsChanged = true;
      },
    });
  }

  /** Fades terrain into the sky before the edge of the loaded area, or lets the edge show. */
  setEdgeFade(enabled: boolean): void {
    this.atmosphere.edgeFade.value = enabled ? 1 : 0;
  }

  /** Retains the preference through dimension/depth switches; no terrain requests. */
  setClouds(enabled: boolean): void {
    this.clouds.setEnabled(enabled);
  }

  /** Cosmetic only; unsupported dimensions/views suspend it without changing this choice. */
  setWeather(mode: WeatherMode): void {
    this.weather.setMode(mode);
  }

  private applyWeatherLighting(): void {
    const rain = this.atmosphere.rain.value,
      storm = this.atmosphere.storm.value;
    this.sun.intensity =
      this.sunIntensity * (1 - rain * 0.55 - storm * 0.2) + this.atmosphere.lightning.value * 2;
    this.sky.intensity =
      this.skyIntensity * (1 - rain * 0.2 - storm * 0.15) + this.atmosphere.lightning.value;
  }

  /**
   * Streams terrain out to `distance` blocks at any zoom, or picks the distance from the
   * zoom when undefined. The haze keeps its thickness either way.
   */
  setRenderDistance(distance: number | undefined): void {
    this.renderDistance = distance;
    this.fitViewDistance();
    this.regionsChanged = true;
  }

  /** Lets the camera zoom out far past the usual limit, with the view growing to match. */
  setZoomUnlocked(unlocked: boolean): void {
    this.rig.setZoomUnlocked(unlocked);
  }

  /** Page Up/Down and held mobile controls share the same bounded vertical movement. */
  setVerticalMovement(direction: VerticalMovement): void {
    this.rig.setVerticalMovement(direction);
  }

  setAutoDepth(enabled: boolean): void {
    this.depthFollow.setEnabled(enabled);
  }

  /** Return above the current cut, retaining X/Z, discoveries and selection. */
  recoverCamera(): void {
    if (this.context.mode !== "caves") return;
    this.clearDiscoveryFocus();
    this.depthFollow.cancel();
    this.rig.stopMovement();
    this.setSelectionTool("off");
    this.rig.setEnabled(true);
    this.rig.setView(
      {
        ...this.snapshot().view,
        y: (this.context.minY + this.context.maxY) / 2,
        distance: 80,
        pitch: MathUtils.degToRad(60),
      },
      { settle: false },
    );
    this.fitViewDistance();
    this.regionsChanged = true;
  }

  flyTo(x: number, z: number): void {
    this.clearDiscoveryFocus();
    this.rig.flyTo(x, z);
  }

  /** Local view state only: no new terrain requests/cache variants for clip bounds. */
  setSelection(input: HorizontalSelection | undefined): void {
    const selection = input === undefined ? undefined : horizontalSelection(input);
    if (selection) this.selections.set(this.context.dimension, selection);
    else this.selections.delete(this.context.dimension);
    this.selectionBox.set(selection, this.context);
    this.streamer.setSelection(this.context.mode === "caves" ? selection : undefined);
    this.discoveries.setSelection(this.context.mode === "caves" ? selection : undefined);
    this.regionsChanged = true;
  }

  setSelectionTool(tool: SelectionTool): void {
    this.selectionBox.setTool(tool);
  }

  setDiscoveryFilters(filters: DiscoveryFilters): void {
    if (this.discoveries.setFilters(filters)) this.clearDiscoveryFocus();
  }

  /** Focus a known block, preserving orientation with a moderate approach. */
  focusOn(point: Pointed): void {
    this.clearDiscoveryFocus();
    this.rig.setFocusPinned(true);
    const previous = this.snapshot().view;
    this.rig.setView(
      { ...previous, ...point, distance: Math.min(previous.distance, 24) },
      { settle: false },
    );
    this.refineDiscovery = true;
    this.fitViewDistance();
    this.regionsChanged = true;
  }

  /** Host-owned marker callbacks call this instead of setWorld followed by focusOn. */
  async focusDiscovery(group: DiscoveryGroup): Promise<boolean> {
    if (group.dimension !== this.context.dimension) return false;
    this.clearDiscoveryFocus();
    this.depthFollow.cancel();
    const controller = new AbortController();
    this.discoveryRequest = controller;
    const exposed = this.discoveries.isExposedDiscovery(group);
    const target = discoveryContext(
      group,
      this.context,
      this.discoveries.isSurfaceDiscovery(group),
      this.caveThickness,
    );
    let contextChanged = false;
    try {
      if (contextKey(target) !== contextKey(this.context)) {
        if (!this.options.loadDepth) return false;
        const next = await this.options.loadDepth(target, controller.signal);
        if (controller.signal.aborted || this.discoveryRequest !== controller) return false;
        if (
          contextKey(next) !== contextKey(target) ||
          (next.snapshotRevision ?? next.revision) !==
            (this.world.snapshotRevision ?? this.world.revision)
        )
          throw new Error("Discovery metadata does not match the requested snapshot/context");
        this.applyWorld(next, true, true);
        contextChanged = true;
      }
      const previous = this.snapshot().view;
      const selection = this.selections.get(this.context.dimension);
      if (
        selection &&
        this.context.mode === "caves" &&
        (group.x < selection.minX ||
          group.x >= selection.maxX ||
          group.z < selection.minZ ||
          group.z >= selection.maxZ)
      )
        this.setSelection(undefined);
      this.rig.stopMovement();
      this.rig.setFocusPinned(true);
      this.rig.setView(
        {
          ...previous,
          x: group.x,
          y: group.y,
          z: group.z,
          distance: discoveryDistance(group, previous.distance, {
            maxY: this.context.maxY,
            pitch: previous.pitch,
            exposed,
          }),
        },
        { settle: false },
      );
      this.selectedDiscovery = group;
      this.refineDiscovery = exposed;
      this.discoveryDetails.show(group);
      this.fitViewDistance();
      this.regionsChanged = true;
      if (contextChanged) this.options.onDepthChange?.(this.context);
      if (controller.signal.aborted || this.discoveryRequest !== controller) return false;
      this.options.onDiscoveryFocusChange?.(group);
      return true;
    } catch (cause) {
      if (!controller.signal.aborted) console.warn(cause);
      return false;
    } finally {
      if (this.discoveryRequest === controller) this.discoveryRequest = undefined;
    }
  }

  clearDiscoveryFocus(): void {
    this.discoveryRequest?.abort();
    this.discoveryRequest = undefined;
    this.refineDiscovery = false;
    this.rig?.setFocusPinned(false);
    if (!this.selectedDiscovery) return;
    this.selectedDiscovery = undefined;
    this.discoveryDetails.show(undefined);
    this.options.onDiscoveryFocusChange?.(undefined);
  }

  zoom(factor: number): void {
    this.rig.zoom(factor);
  }

  private get cssHeight(): number {
    return Math.max(1, this.container.clientHeight);
  }

  private focusPixelsPerBlock(): number {
    return pixelsPerBlock(this.rig.distance, this.camera.fov, this.cssHeight);
  }

  /** Starts a transition when the projection to show changes; jumps to its end without `animate`. */
  private updateProjectionTarget(animate: boolean): void {
    const shown = effectiveProjection(
      this.projectionChoice,
      this.projectionShown,
      { pixelsPerBlock: this.focusPixelsPerBlock(), pitch: this.rig.pitch },
      this.autoPerspective,
    );
    if (shown !== this.projectionShown) {
      this.projectionShown = shown;
      this.projectionFrom = this.camera.projectionBlend;
      this.projectionProgress = 0;
    }
    if (!animate) {
      this.projectionProgress = 1;
      this.advanceProjection(0);
    }
  }

  /** Moves the projection blend toward the shown projection; true when it changed. */
  private advanceProjection(delta: number): boolean {
    const target = this.projectionShown === "isometric" ? 1 : 0;
    if (this.projectionProgress < 1)
      this.projectionProgress = Math.min(
        1,
        this.projectionProgress + delta / PROJECTION_TRANSITION_SECONDS,
      );
    const blend = MathUtils.lerp(
      this.projectionFrom,
      target,
      easeProjection(this.projectionProgress),
    );
    if (blend === this.camera.projectionBlend) return false;
    this.camera.projectionBlend = blend;
    this.atmosphere.projectionBlend.value = blend;
    this.camera.updateProjectionMatrix();
    return true;
  }

  faceNorth(): void {
    this.rig.faceNorth();
  }

  /** The block under a canvas position: the first loaded surface along the pointer ray. */
  pick(clientX: number, clientY: number): Pointed | undefined {
    const ray = pointerRay(this.camera, this.renderer.domElement, clientX, clientY);
    const hit = this.streamer.raycast(ray.origin, ray.direction, rayReach(this.camera));
    if (hit === undefined) return undefined;
    // Half a block behind the face lies the block it belongs to.
    const point = ray.at(hit.distance, new Vector3());
    point.setComponent(hit.axis, point.getComponent(hit.axis) - hit.sign * 0.5);
    return { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) };
  }

  dispose(): void {
    this.clearDiscoveryFocus();
    this.depthFollow.cancel();
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.rig.dispose();
    this.selectionBox.dispose();
    this.discoveries.dispose();
    this.discoveryDetails.dispose();
    this.clouds.dispose();
    this.weather.dispose();
    this.streamer.dispose();
    this.explorationRequests.dispose();
    this.meshPool.dispose();
    this.pipeline.dispose();
    for (const pair of Object.values(this.materials)) {
      pair.steady.dispose();
      pair.fading.dispose();
    }
    this.sun.shadow.dispose();
    this.timer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private frame(): void {
    this.timer.update();
    const frameDelta = this.timer.getDelta();
    const delta = Math.min(frameDelta, 0.1);
    const moved = this.rig.update(delta);
    this.updateProjectionTarget(true);
    const projected = this.advanceProjection(delta);
    if (moved || projected) this.fitViewDistance();
    if (moved || projected || this.regionsChanged || this.frames % 15 === 0) {
      this.streamer.update(this.camera, this.renderer.domElement.height);
    }
    if (this.streamer.animate(performance.now())) this.regionsChanged = true;
    const terrain = this.streamer.stats;
    this.discoveries.setTerrainRevision(this.streamer.surfaceRevision);
    if (this.refineDiscovery && terrain.loading === 0 && terrain.remaining === 0) {
      this.refineDiscovery = false;
      const view = this.snapshot().view;
      const direction = this.camera.position.clone().sub(this.rig.focus).normalize();
      const hit = this.streamer.raycast(this.rig.focus, direction, view.distance);
      if (hit && hit.distance > 2 && hit.distance < view.distance) {
        this.rig.setView(
          { ...view, distance: Math.max(1.5, hit.distance - 0.5) },
          { settle: false },
        );
        this.fitViewDistance();
      }
    }
    this.discoveryDetails.update(this.renderer.domElement);
    this.depthFollow.update(
      this.context,
      this.rig.focus.y,
      this.rig.verticalMovement,
      terrain.loading === 0 && terrain.remaining === 0,
      performance.now(),
    );
    this.discoveries.update(
      this.camera,
      this.rig.focus,
      terrain.loading === 0 && terrain.remaining === 0,
      this.renderer.domElement,
    );
    this.updateShadow();
    const rain = this.rainVolume();
    this.weather.update(
      delta,
      frameDelta,
      rain.origin,
      this.streamer.surfaceRevision,
      (x, z) => this.streamer.exactHeightAt(x, z) ?? this.streamer.heightAt(x, z),
      rain.scale,
    );
    this.applyWeatherLighting();
    this.clouds.update(delta, this.camera.position);
    this.regionsChanged = false;
    this.pipeline.render();
    this.countFrame();
  }

  /** Sees farther from higher up, in steps so streaming does not churn while zooming. */
  private fitViewDistance(): void {
    const zoom = this.rig.distance;
    // Past the usual zoom limit, the view keeps growing so the ground stays in reach.
    const beyond = Math.max(0, zoom - ZOOM_LIMIT) * 3;
    const wanted = MathUtils.clamp(1400 + zoom * 3, 1600, 6000) + beyond;
    const distance = Math.round(Math.min(wanted, AUTO_VIEW_LIMIT) / 200) * 200;
    const caves = this.context.mode === "caves";
    const caveReach = Math.min(
      this.options.caveViewDistance ?? CAVE_LIMITS.viewDistance,
      CAVE_LIMITS.viewDistance,
    );
    const reach = caves
      ? Math.min(this.renderDistance ?? caveReach, caveReach)
      : (this.renderDistance ?? distance);
    this.streamer.setViewDistance(reach);
    this.atmosphere.viewDistance.value = reach;
    this.atmosphere.hazeDistance.value = caves
      ? 300
      : this.context.dimension === "overworld"
        ? distance
        : DIMENSIONS[this.context.dimension].atmosphere.hazeDistance;
    // Far from the world, a farther near plane keeps the depth buffer precise.
    this.camera.near = MathUtils.clamp(zoom / 400, zoom < 6 ? 0.1 : 1, 50);
    // Regions start within reach, and their far corners can lie a few thousand blocks beyond.
    this.camera.far = reach * 1.2 + (caves ? 256 : 4000);
    this.camera.focusDistance = zoom;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Fits the shadow map around the camera focus. It re-renders only when the snapped
   * focus, the zoom band, the sun, or the loaded terrain changes.
   */
  private updateShadow(): void {
    const focus = this.rig.focus;
    // Extents snap to steps of the square root of two, so zooming re-renders only a few times.
    const wanted = MathUtils.clamp(this.shadowReach(), 48, MAX_SHADOW_EXTENT);
    const extent = 2 ** (Math.round(Math.log2(wanted) * 2) / 2);
    const texel = (extent * 2) / SHADOW_MAP_SIZE;
    // The depth range grows with the map, and the biases keep the same size in blocks.
    const sunDistance = Math.max(900, extent * 1.5);
    const depth = sunDistance * 2.2;
    const step = texel * 16;
    const snappedX = Math.round(focus.x / step) * step;
    const snappedZ = Math.round(focus.z / step) * step;
    const key = `${snappedX}/${snappedZ}/${Math.round(focus.y)}/${extent.toFixed(1)}`;
    if (key === this.shadowKey && !this.regionsChanged) return;
    this.shadowKey = key;

    const shadowCamera = this.sun.shadow.camera;
    shadowCamera.left = -extent;
    shadowCamera.right = extent;
    shadowCamera.top = extent;
    shadowCamera.bottom = -extent;
    shadowCamera.near = 1;
    shadowCamera.far = depth;
    shadowCamera.updateProjectionMatrix();
    this.sun.shadow.bias = -0.8 / depth;
    this.sun.shadow.normalBias = Math.max(0.35, texel * 1.4);
    this.sun.target.position.set(snappedX, focus.y, snappedZ);
    this.sun.position
      .copy(this.sun.target.position)
      .addScaledVector(this.sunDirection, sunDistance);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
    this.sun.shadow.needsUpdate = true;
  }

  /**
   * Where the rain volume sits and how large it is. Perspective keeps it around the camera.
   * An isometric view moves it to the focus and grows it with the zoom, so it covers the
   * visible ground and drops keep their density and length on screen.
   */
  private rainVolume(): { readonly origin: Vector3; readonly scale: number } {
    const blend = this.camera.projectionBlend;
    if (!(blend > 0)) return { origin: this.camera.position, scale: 1 };
    const half = this.rig.distance * Math.tan(MathUtils.DEG2RAD * this.camera.fov * 0.5);
    const footprint = Math.hypot(
      half * this.camera.aspect,
      half / Math.max(Math.sin(this.rig.pitch), 0.2),
    );
    // Drops are fully visible within 22 volume units of the center; see WeatherLayer.
    const scale = Math.max(footprint / 22, 0.25);
    return {
      origin: this.rainOrigin.copy(this.camera.position).lerp(this.rig.focus, blend),
      scale: MathUtils.lerp(1, scale, blend),
    };
  }

  /** Half the width of ground around the focus that needs shadows, in blocks. */
  private shadowReach(): number {
    const reach = this.rig.distance * 1.25;
    const blend = this.camera.projectionBlend;
    if (!(blend > 0)) return reach;
    // An isometric view keeps one scale out to the screen edges, so the map must span the whole
    // footprint: the visible height on the focus plane, stretched along the ground by the pitch.
    const half = this.rig.distance * Math.tan(MathUtils.DEG2RAD * this.camera.fov * 0.5);
    const footprint =
      Math.max(half * this.camera.aspect, half / Math.max(Math.sin(this.rig.pitch), 0.2)) * 1.1;
    return MathUtils.lerp(reach, Math.max(reach, footprint), blend);
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.focusDistance = this.rig.distance;
    this.camera.updateProjectionMatrix();
  }

  private countFrame(): void {
    this.frames += 1;
    const now = performance.now();
    if (now - this.frameWindowStart >= 1000) {
      this.framesPerSecond = (this.frames * 1000) / (now - this.frameWindowStart);
      this.frames = 0;
      this.frameWindowStart = now;
    }
  }
}
