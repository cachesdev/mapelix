import {
  EMPTY_HEIGHT,
  MAX_REGION_LEVEL,
  decodeSceneRegion,
  regionSpan,
} from "@mapelix/scene-prototype/format";
import { Box3, Frustum, Group, Matrix4, Vector3, type PerspectiveCamera } from "three/webgpu";

import { RegionMesh } from "./region-mesh";
import type { SceneMaterials } from "./shaders/materials";

export interface StreamingOptions {
  readonly revision: string;
  readonly materials: SceneMaterials;
  /** A node splits into its four children when the camera is nearer than `span * detail`. */
  readonly detail: number;
  /** Nodes farther than this many blocks are not requested. */
  readonly viewDistance: number;
  readonly maxRequests: number;
  /** Streamed regions are evicted least recently drawn first above this many quad bytes. */
  readonly memoryBudget: number;
  /** Called after a region arrives, so the viewer can redraw and refresh shadows. */
  readonly onRegion: () => void;
}

export interface StreamingStats {
  readonly drawn: number;
  readonly cached: number;
  readonly loading: number;
  /** Regions the view still needs, including those loading now. */
  readonly remaining: number;
  readonly megabytes: number;
}

interface RegionNode {
  readonly level: number;
  readonly x: number;
  readonly z: number;
  readonly key: string;
}

interface CachedRegion {
  /** Undefined for regions the world never stored. */
  readonly mesh: RegionMesh | undefined;
  lastDrawn: number;
}

interface Wanted {
  readonly node: RegionNode;
  readonly priority: number;
}

interface Fade {
  readonly entering: boolean;
  /** Time in milliseconds when the fade would have started from nothing. */
  readonly start: number;
}

/** Terrain height range assumed for nodes that are not loaded yet. */
const TYPICAL_LOW = 40;
const TYPICAL_HIGH = 140;

/** How long a region takes to dissolve in or out, in milliseconds. */
const FADE_DURATION = 450;

/**
 * Chooses and streams regions around the camera. Each area is drawn at one level:
 * a node refines into its children only when all four are ready, so the terrain
 * never has holes or overlapping levels while detail arrives. Regions dissolve in
 * and out, so new detail replaces the old without a visible pop.
 */
export class RegionStreamer {
  readonly root = new Group();
  private readonly options: StreamingOptions;
  private readonly cache = new Map<string, CachedRegion>();
  private readonly requests = new Map<string, AbortController>();
  private readonly drawn = new Map<string, RegionMesh>();
  private readonly fades = new Map<RegionMesh, Fade>();
  private wanted: Wanted[] = [];
  private frame = 0;
  private bytes = 0;
  private readonly frustum = new Frustum();
  private readonly box = new Box3();
  private readonly matrix = new Matrix4();
  private readonly cameraPosition = new Vector3();
  private viewDistance: number;

  constructor(options: StreamingOptions) {
    this.options = options;
    this.viewDistance = options.viewDistance;
    this.root.matrixAutoUpdate = false;
  }

  /** Changes how far regions are requested, for example when the camera zooms out. */
  setViewDistance(distance: number): void {
    this.viewDistance = distance;
  }

  get stats(): StreamingStats {
    return {
      drawn: this.drawn.size,
      cached: this.cache.size,
      loading: this.requests.size,
      remaining: this.wanted.length,
      megabytes: this.bytes / (1024 * 1024),
    };
  }

  /** Recomputes the drawn set for this camera and starts the most useful requests. */
  update(camera: PerspectiveCamera): void {
    this.frame += 1;
    camera.updateMatrixWorld();
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);

    const wanted: Wanted[] = [];
    const draw: RegionMesh[] = [];
    const span = regionSpan(MAX_REGION_LEVEL);
    const reach = this.viewDistance;
    const { x, z } = this.cameraPosition;
    for (
      let rootZ = Math.floor((z - reach) / span);
      rootZ <= Math.floor((z + reach) / span);
      rootZ += 1
    ) {
      for (
        let rootX = Math.floor((x - reach) / span);
        rootX <= Math.floor((x + reach) / span);
        rootX += 1
      ) {
        this.resolve(node(MAX_REGION_LEVEL, rootX, rootZ), draw, wanted);
      }
    }

    this.show(draw);
    this.schedule(wanted);
    this.evict();
  }

  /**
   * Advances the dissolves. Returns true when a region finished fading out, so its
   * shadow can be cleared from the shadow map.
   */
  animate(now: number): boolean {
    let removed = false;
    for (const [mesh, fade] of this.fades) {
      const progress = Math.min((now - fade.start) / FADE_DURATION, 1);
      if (progress < 1) {
        mesh.setFade(fade.entering ? { low: 0, high: progress } : { low: progress, high: 1 });
        continue;
      }
      mesh.setFade();
      this.fades.delete(mesh);
      if (!fade.entering) {
        this.root.remove(mesh.group);
        removed = true;
      }
    }
    return removed;
  }

  /** Height of the highest block at a world column, from the finest region drawn there. */
  heightAt(x: number, z: number): number | undefined {
    for (let level = 0; level <= MAX_REGION_LEVEL; level += 1) {
      const span = regionSpan(level);
      const mesh = this.drawn.get(regionKey(level, Math.floor(x / span), Math.floor(z / span)));
      if (mesh === undefined) continue;
      const { region } = mesh;
      const cellX = Math.floor((x - region.originX) / region.cellSize);
      const cellZ = Math.floor((z - region.originZ) / region.cellSize);
      const height = region.heights[cellZ * region.gridSize + cellX];
      return height === undefined || height === EMPTY_HEIGHT ? undefined : height;
    }
    return undefined;
  }

  dispose(): void {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    for (const cached of this.cache.values()) cached.mesh?.dispose();
    this.cache.clear();
    this.drawn.clear();
    this.fades.clear();
    this.root.clear();
  }

  /**
   * Adds what should be drawn for `target` to `draw`. Returns whether the whole
   * area is covered, either by the node itself or by all of its descendants.
   */
  private resolve(target: RegionNode, draw: RegionMesh[], wanted: Wanted[]): boolean {
    const distance = this.distanceTo(target);
    if (distance > this.viewDistance) return true;
    const cached = this.cache.get(target.key);
    const refine = target.level > 0 && distance < regionSpan(target.level) * this.options.detail;

    if (!refine) {
      if (cached !== undefined) return this.use(cached, draw);
      wanted.push({ node: target, priority: this.priority(target, distance) });
      // While zooming out, finer regions that are still cached fill in until this one arrives.
      return this.coverWithCached(target, draw, 2);
    }

    const childDraw: RegionMesh[] = [];
    let covered = true;
    for (const child of children(target))
      covered = this.resolve(child, childDraw, wanted) && covered;
    if (covered || cached === undefined) {
      draw.push(...childDraw);
      return covered;
    }
    // Keep the coarser node on screen until every child can replace it.
    return this.use(cached, draw);
  }

  /** Draws cached descendants of `target`, up to `depth` levels down, without new requests. */
  private coverWithCached(target: RegionNode, draw: RegionMesh[], depth: number): boolean {
    if (depth === 0 || target.level === 0) return false;
    let covered = true;
    for (const child of children(target)) {
      const cached = this.cache.get(child.key);
      covered =
        (cached !== undefined
          ? this.use(cached, draw)
          : this.coverWithCached(child, draw, depth - 1)) && covered;
    }
    return covered;
  }

  private use(cached: CachedRegion, draw: RegionMesh[]): boolean {
    cached.lastDrawn = this.frame;
    if (cached.mesh !== undefined) draw.push(cached.mesh);
    return true;
  }

  private show(draw: readonly RegionMesh[]): void {
    const next = new Map(
      draw.map((mesh) => [regionKey(mesh.region.level, mesh.region.x, mesh.region.z), mesh]),
    );
    const now = performance.now();
    for (const [key, mesh] of this.drawn) {
      if (!next.has(key)) this.startFade(mesh, false, now);
    }
    for (const [key, mesh] of next) {
      if (this.drawn.has(key)) continue;
      if (!this.fades.has(mesh)) this.root.add(mesh.group);
      this.startFade(mesh, true, now);
    }
    this.drawn.clear();
    for (const [key, mesh] of next) this.drawn.set(key, mesh);
  }

  /** A region that turns around mid-fade keeps the share of the screen it already had. */
  private startFade(mesh: RegionMesh, entering: boolean, now: number): void {
    const current = this.fades.get(mesh);
    const shown = current === undefined ? (entering ? 0 : 1) : this.shownShare(current, now);
    const elapsed = entering ? shown : 1 - shown;
    this.fades.set(mesh, { entering, start: now - elapsed * FADE_DURATION });
  }

  private shownShare(fade: Fade, now: number): number {
    const progress = Math.min((now - fade.start) / FADE_DURATION, 1);
    return fade.entering ? progress : 1 - progress;
  }

  /** Starts the nearest requests first and cancels those the camera no longer needs. */
  private schedule(wanted: Wanted[]): void {
    wanted.sort((left, right) => left.priority - right.priority);
    this.wanted = wanted;
    const keep = new Set(wanted.slice(0, this.options.maxRequests * 2).map(({ node }) => node.key));
    for (const [key, controller] of this.requests) {
      if (!keep.has(key)) {
        controller.abort();
        this.requests.delete(key);
      }
    }
    for (const { node } of wanted) {
      if (this.requests.size >= this.options.maxRequests) break;
      if (!this.requests.has(node.key)) this.request(node);
    }
  }

  private request(target: RegionNode): void {
    const controller = new AbortController();
    this.requests.set(target.key, controller);
    const url = `/regions/${target.level}/${target.x}/${target.z}?revision=${this.options.revision}`;
    fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Region ${target.key} failed with ${response.status}`);
        const region = decodeSceneRegion(new Uint8Array(await response.arrayBuffer()));
        const mesh = new RegionMesh(region, this.options.materials);
        this.store(target, mesh.isEmpty ? undefined : mesh);
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          console.warn(cause);
        }
      })
      .finally(() => {
        if (this.requests.get(target.key) === controller) this.requests.delete(target.key);
      });
  }

  private store(target: RegionNode, mesh: RegionMesh | undefined): void {
    this.cache.set(target.key, { mesh, lastDrawn: this.frame });
    this.bytes += mesh?.byteLength ?? 0;
    this.options.onRegion();
  }

  private evict(): void {
    if (this.bytes <= this.options.memoryBudget) return;
    const stale = [...this.cache.entries()]
      .filter(([key, { mesh }]) => !this.drawn.has(key) && !(mesh && this.fades.has(mesh)))
      .sort(([, left], [, right]) => left.lastDrawn - right.lastDrawn);
    for (const [key, cached] of stale) {
      if (this.bytes <= this.options.memoryBudget * 0.85) break;
      this.cache.delete(key);
      this.bytes -= cached.mesh?.byteLength ?? 0;
      cached.mesh?.dispose();
    }
  }

  private distanceTo(target: RegionNode): number {
    const span = regionSpan(target.level);
    const cached = this.cache.get(target.key)?.mesh?.region;
    this.box.min.set(target.x * span, cached?.minY ?? TYPICAL_LOW, target.z * span);
    this.box.max.set((target.x + 1) * span, cached?.maxY ?? TYPICAL_HIGH, (target.z + 1) * span);
    return this.box.distanceToPoint(this.cameraPosition);
  }

  /** Nearer nodes load first; nodes outside the view wait behind visible ones. */
  private priority(target: RegionNode, distance: number): number {
    const span = regionSpan(target.level);
    this.box.min.set(target.x * span, TYPICAL_LOW - 64, target.z * span);
    this.box.max.set((target.x + 1) * span, TYPICAL_HIGH + 64, (target.z + 1) * span);
    return this.frustum.intersectsBox(this.box) ? distance : distance * 3 + span;
  }
}

function node(level: number, x: number, z: number): RegionNode {
  return { level, x, z, key: regionKey(level, x, z) };
}

function children(parent: RegionNode): RegionNode[] {
  const level = parent.level - 1;
  const x = parent.x * 2;
  const z = parent.z * 2;
  return [
    node(level, x, z),
    node(level, x + 1, z),
    node(level, x, z + 1),
    node(level, x + 1, z + 1),
  ];
}

function regionKey(level: number, x: number, z: number): string {
  return `${level}/${x}/${z}`;
}
