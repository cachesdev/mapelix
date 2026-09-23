import {
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  Ray,
  RenderPipeline,
  Scene,
  Timer,
  Vector2,
  Vector3,
  WebGPURenderer,
} from "three/webgpu";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { normalWorldGeometry, pass } from "three/tsl";

import { Atmosphere } from "./atmosphere";
import { CameraRig, ZOOM_LIMIT, type CameraView } from "./camera-rig";
import { RegionStreamer, type StreamingStats } from "./region-streamer";
import { createSceneMaterials } from "./shaders/materials";

export interface WorldInfo {
  readonly name: string;
  readonly spawn: { readonly x: number; readonly y: number; readonly z: number };
  readonly revision: string;
}

export type { CameraView } from "./camera-rig";

export interface ViewerSnapshot {
  readonly backend: "WebGPU" | "WebGL 2";
  readonly framesPerSecond: number;
  readonly view: CameraView;
  readonly streaming: StreamingStats;
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
  private readonly camera = new PerspectiveCamera(50, 1, 1, 12000);
  private readonly atmosphere = new Atmosphere();
  private readonly sun = new DirectionalLight(0xffffff, 3);
  private readonly sky = new HemisphereLight(0xb9d3ec, 0x8a7a62, 1.4);
  private readonly streamer: RegionStreamer;
  private readonly rig: CameraRig;
  private readonly timer = new Timer();
  private readonly resizeObserver: ResizeObserver;
  private readonly sunDirection = new Vector3(0.4, 0.7, 0.3);
  private shadowKey = "";
  private regionsChanged = true;
  /** A fixed render distance in blocks, or undefined to follow the zoom. */
  private renderDistance: number | undefined;
  private frames = 0;
  private frameWindowStart = performance.now();
  private framesPerSecond = 0;

  private constructor(
    container: HTMLElement,
    world: WorldInfo,
    renderer: WebGPURenderer,
    start: Partial<CameraView>,
  ) {
    this.container = container;
    this.renderer = renderer;
    container.append(renderer.domElement);

    const materials = createSceneMaterials(this.atmosphere);
    this.streamer = new RegionStreamer({
      revision: world.revision,
      materials,
      voxelPixels: 2.2,
      blockPixels: 4.4,
      viewDistance: this.atmosphere.viewDistance.value,
      maxRequests: 10,
      memoryBudget: 1024 * 1024 * 1024,
      onRegion: () => {
        this.regionsChanged = true;
      },
    });
    this.scene.add(this.streamer.root, this.sky, this.sun, this.sun.target);
    this.scene.backgroundNode = this.atmosphere.sky(normalWorldGeometry);
    this.scene.fogNode = this.atmosphere.fogNode;

    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    this.sun.shadow.autoUpdate = false;

    this.rig = new CameraRig(this.camera, renderer.domElement, (x, z) =>
      this.streamer.heightAt(x, z),
    );
    this.rig.setView({
      x: world.spawn.x,
      y: world.spawn.y,
      z: world.spawn.z,
      distance: 160,
      heading: MathUtils.degToRad(35),
      pitch: MathUtils.degToRad(42),
      ...start,
    });

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
  ): Promise<WorldViewer> {
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
    return new WorldViewer(container, world, renderer, start);
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
    };
  }

  /** Hour of the day from 0 to 24. Noon is 12. */
  setTimeOfDay(hour: number): void {
    const daylight = this.atmosphere.setTimeOfDay(hour);
    this.sun.color.copy(daylight.sunColor);
    this.sun.intensity = daylight.sunIntensity;
    this.sky.color.copy(daylight.skyColor);
    this.sky.groundColor.copy(daylight.groundColor);
    this.sky.intensity = daylight.ambientIntensity * 3.1;
    this.sunDirection.copy(daylight.direction);
    this.glow.strength.value = MathUtils.lerp(0.9, 0.45, daylight.daylight);
    this.shadowKey = "";
  }

  /** Fades terrain into the sky before the edge of the loaded area, or lets the edge show. */
  setEdgeFade(enabled: boolean): void {
    this.atmosphere.edgeFade.value = enabled ? 1 : 0;
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

  flyTo(x: number, z: number): void {
    this.rig.flyTo(x, z);
  }

  zoom(factor: number): void {
    this.rig.zoom(factor);
  }

  faceNorth(): void {
    this.rig.faceNorth();
  }

  /** The block under a canvas position, found by marching the view ray over loaded heights. */
  pick(clientX: number, clientY: number): Pointed | undefined {
    const bounds = this.renderer.domElement.getBoundingClientRect();
    const pointer = new Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    const ray = new Ray();
    ray.origin.setFromMatrixPosition(this.camera.matrixWorld);
    ray.direction.set(pointer.x, pointer.y, 0.5).unproject(this.camera).sub(ray.origin).normalize();
    return marchHeights(ray, this.camera.far, (x, z) => this.streamer.heightAt(x, z));
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.rig.dispose();
    this.streamer.dispose();
    this.pipeline.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private frame(): void {
    this.timer.update();
    const delta = Math.min(this.timer.getDelta(), 0.1);
    const moved = this.rig.update(delta);
    if (moved) this.fitViewDistance();
    if (moved || this.regionsChanged || this.frames % 15 === 0) {
      this.streamer.update(this.camera, this.renderer.domElement.height);
    }
    if (this.streamer.animate(performance.now())) this.regionsChanged = true;
    this.updateShadow();
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
    const reach = this.renderDistance ?? distance;
    this.streamer.setViewDistance(reach);
    this.atmosphere.viewDistance.value = reach;
    this.atmosphere.hazeDistance.value = distance;
    // Far from the world, a farther near plane keeps the depth buffer precise.
    this.camera.near = MathUtils.clamp(zoom / 400, 1, 50);
    // Regions start within reach, and their far corners can lie a few thousand blocks beyond.
    this.camera.far = reach * 1.2 + 4000;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Fits the shadow map around the camera focus. It re-renders only when the snapped
   * focus, the zoom band, the sun, or the loaded terrain changes.
   */
  private updateShadow(): void {
    const focus = this.rig.focus;
    // Extents snap to steps of the square root of two, so zooming re-renders only a few times.
    const wanted = MathUtils.clamp(this.rig.distance * 1.25, 48, MAX_SHADOW_EXTENT);
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

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
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

/** Steps along a ray until it dips below the terrain, then bisects to the block. */
function marchHeights(
  ray: Ray,
  reach: number,
  heightAt: (x: number, z: number) => number | undefined,
): Pointed | undefined {
  const point = new Vector3();
  let previous = 0;
  for (let distance = 1; distance < reach; distance += Math.max(0.5, distance * 0.004)) {
    ray.at(distance, point);
    const height = heightAt(point.x, point.z);
    if (height !== undefined && point.y <= height) {
      let low = previous;
      let high = distance;
      for (let step = 0; step < 12; step += 1) {
        const middle = (low + high) / 2;
        ray.at(middle, point);
        const middleHeight = heightAt(point.x, point.z);
        if (middleHeight !== undefined && point.y <= middleHeight) high = middle;
        else low = middle;
      }
      ray.at(high, point);
      const x = Math.floor(point.x);
      const z = Math.floor(point.z);
      return { x, y: (heightAt(point.x, point.z) ?? Math.ceil(point.y)) - 1, z };
    }
    previous = distance;
  }
  return undefined;
}
