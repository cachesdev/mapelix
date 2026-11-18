import {
  EMPTY_HEIGHT,
  MAX_REGION_LEVEL,
  decodeSceneRegion,
  regionCellSize,
  regionSpan,
} from "@mapelix/scene-prototype/format";
import {
  Box3,
  Frustum,
  Group,
  MathUtils,
  Matrix4,
  Vector3,
  type PerspectiveCamera,
} from "three/webgpu";

import { regionEntry, type SurfaceHit } from "./quad-collider";
import { projectedPixels, ViewCamera } from "./view-projection";
import { RegionMesh, type RegionMeshPool } from "./region-mesh";
import { ExplorationRequestError, ExplorationRequests } from "./exploration-requests";
import { exteriorBlock } from "./surface-visibility";
import type { SceneMaterials } from "./shaders/materials";
import {
  selectionContains,
  selectionIntersects,
  selectedRayRange,
  type HorizontalSelection,
} from "@mapelix/scene-prototype/selection";
import {
  DIMENSIONS,
  CAVE_LIMITS,
  contextSearch,
  sceneContext,
  type SceneContextInput,
} from "@mapelix/scene-prototype/dimensions";

export interface StreamingOptions {
  readonly context: SceneContextInput;
  readonly revision: string;
  readonly regionBase?: string;
  readonly regionSuffix?: string;
  readonly meshPool?: RegionMeshPool;
  readonly explorationRequests?: ExplorationRequests;
  readonly materials: SceneMaterials;
  /**
   * Largest size of a voxel on screen, in pixels. A node splits into its four children
   * when its nearest voxels would draw larger than this.
   */
  readonly voxelPixels: number;
  /** Blocks show their full shapes once a block draws larger than this many pixels. */
  readonly blockPixels: number;
  /** Nodes farther than this many blocks are not requested. */
  readonly viewDistance: number;
  readonly maxRequests: number;
  /** Streamed regions are evicted least recently drawn first above this many quad bytes. */
  readonly memoryBudget: number;
  /** Called after a region arrives, so the viewer can redraw and refresh shadows. */
  readonly onRegion: () => void;
  /**
   * Called when the server answers that the texture revision of a textured region is not
   * served (409 or 400): its texture stack changed, and fresh world metadata names the new one.
   */
  readonly onStaleTextures?: () => void;
}

/** The textured variant of nearby level 0 regions; see `RegionStreamer.setTextures`. */
export interface StreamedTextures {
  /** Texture revision from the world metadata, sent as `?textures=`. */
  readonly revision: string;
  readonly materials: SceneMaterials;
  /** Device pixels per block from which a region's nearest block asks for its textures. */
  readonly minPixels: number;
  /**
   * Detailed leaves: regions built with the faces between leaves and other cut-out blocks
   * (`?cutout=1`), whose leaf faces are marked cut out.
   */
  readonly cutout?: boolean;
}

/** Cache key prefix of the textured twins of one variant; all start with `t/`. */
function texturedPrefix(textures: StreamedTextures): string {
  return textures.cutout === true ? "t/c/" : "t/";
}

/** Textured regions kept in memory beyond those drawn. */
const TEXTURED_CACHE = 160;

export interface StreamingStats {
  readonly drawn: number;
  /** Drawn regions with block textures. */
  readonly textured: number;
  readonly cached: number;
  readonly loading: number;
  /** Regions the view still needs, including those loading now. */
  readonly remaining: number;
  readonly megabytes: number;
  readonly quads: number;
}

interface RegionNode {
  readonly level: number;
  readonly x: number;
  readonly z: number;
  readonly key: string;
  /** The textured variant of a level 0 region, cached under its own key. */
  readonly textured?: boolean;
}

interface CachedRegion {
  /** Undefined for regions the world never stored. */
  readonly mesh: RegionMesh | undefined;
  lastDrawn: number;
  /**
   * Stored while the view was blended or isometric, where perspective would not have asked
   * for it. Perspective then ignores its heights until it uses the region itself, so its
   * levels of detail match a view opened directly in perspective.
   */
  blended: boolean;
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
  private readonly explorationRequests: ExplorationRequests;
  private readonly drawn = new Map<string, RegionMesh>();
  private readonly fades = new Map<RegionMesh, Fade>();
  private wanted: Wanted[] = [];
  private frame = 0;
  private bytes = 0;
  private readonly frustum = new Frustum();
  private readonly box = new Box3();
  private readonly matrix = new Matrix4();
  private readonly cameraPosition = new Vector3();
  /** Screen pixels covered by one block at a distance of one block. */
  private pixelsPerBlock = 1;
  /** Orthographic share of the camera projection, see `ViewCamera`. */
  private projectionBlend = 0;
  private focusDistance = 1;
  private viewDistance: number;
  private disposed = false;
  private readonly context;
  private readonly maxLevel: number;
  private selection: HorizontalSelection | undefined;
  private detailRevision = 0;
  private textures: StreamedTextures | undefined;
  /** Textured regions the server could not give; not asked again for this revision. */
  private readonly texturedFailures = new Set<string>();

  get surfaceRevision(): number {
    return this.detailRevision;
  }

  /** A proof of Surface visibility must never use a reduced cell's height. */
  exactHeightAt(x: number, z: number): number | undefined {
    const span = regionSpan(0),
      rx = Math.floor(x / span),
      rz = Math.floor(z / span);
    const region = this.cache.get(regionKey(0, rx, rz))?.mesh?.region;
    if (!region || region.level !== 0 || region.cellSize !== 1) return undefined;
    const height =
      region.heights[
        (Math.floor(z) - region.originZ) * region.gridSize + Math.floor(x) - region.originX
      ];
    return height === EMPTY_HEIGHT ? undefined : height;
  }

  isSurfaceBlock(x: number, y: number, z: number): boolean {
    if (this.context.mode !== "surface") return false;
    return exteriorBlock(
      x,
      y,
      z,
      (cx, cz) => this.exactHeightAt(cx, cz),
      (cx, cy, cz, axis, sign) => {
        const span = regionSpan(0);
        return (
          this.cache
            .get(regionKey(0, Math.floor(cx / span), Math.floor(cz / span)))
            ?.mesh?.collider.hasBlockFace(cx, cy, cz, axis, sign) ?? false
        );
      },
    );
  }

  /** Rooms under a roof may be part of Surface; sealed underground rooms are culled. */
  isRenderedSurfaceBlock(x: number, y: number, z: number): boolean {
    if (this.context.mode !== "surface") return false;
    const span = regionSpan(0);
    return (
      this.cache
        .get(regionKey(0, Math.floor(x / span), Math.floor(z / span)))
        ?.mesh?.collider.hasBlockFace(x, y, z) ?? false
    );
  }

  constructor(options: StreamingOptions) {
    this.options = options;
    this.explorationRequests =
      options.explorationRequests ?? new ExplorationRequests(options.maxRequests);
    this.context = sceneContext(options.context.dimension, options.context);
    this.maxLevel = this.context.mode === "caves" ? CAVE_LIMITS.maxLevel : MAX_REGION_LEVEL;
    this.viewDistance = options.viewDistance;
    this.root.matrixAutoUpdate = false;
  }

  /** Changes how far regions are requested, for example when the camera zooms out. */
  setViewDistance(distance: number): void {
    this.viewDistance = distance;
  }

  setSelection(selection: HorizontalSelection | undefined): void {
    this.selection = selection;
  }

  /**
   * Draws nearby level 0 Surface regions with block textures, or stops. Textured regions are
   * a second variant: the plain region stays on screen until its textured twin arrives, then
   * they dissolve into each other, and back when textures stop or the camera moves away.
   */
  setTextures(textures: StreamedTextures | undefined): void {
    const previous = this.textures;
    this.textures = textures;
    if (
      this.textures !== undefined &&
      previous?.revision === this.textures.revision &&
      previous.cutout === this.textures.cutout
    )
      return;
    this.texturedFailures.clear();
    for (const [key, controller] of this.requests) {
      if (!key.startsWith("t/")) continue;
      controller.abort();
      this.requests.delete(key);
    }
    const shown = new Set(this.drawn.values());
    for (const [key, cached] of this.cache) {
      if (!key.startsWith("t/")) continue;
      if (cached.mesh && (shown.has(cached.mesh) || this.fades.has(cached.mesh))) continue;
      this.cache.delete(key);
      this.bytes -= cached.mesh?.byteLength ?? 0;
      cached.mesh?.dispose();
    }
  }

  /**
   * Removes every textured region at once, those on screen included, for textures whose atlas
   * goes away. Their plain twins show again straight away, without a dissolve.
   */
  dropTextured(): void {
    this.setTextures(undefined);
    for (const [key, cached] of this.cache) {
      if (!key.startsWith("t/")) continue;
      this.cache.delete(key);
      const mesh = cached.mesh;
      if (mesh === undefined) continue;
      this.bytes -= mesh.byteLength;
      for (const [drawnKey, drawnMesh] of this.drawn) {
        if (drawnMesh !== mesh) continue;
        const plain = this.cache.get(drawnKey)?.mesh;
        if (plain === undefined) {
          this.drawn.delete(drawnKey);
          continue;
        }
        this.fades.delete(plain);
        plain.setFade();
        if (plain.group.parent !== this.root) this.root.add(plain.group);
        this.drawn.set(drawnKey, plain);
      }
      this.fades.delete(mesh);
      this.root.remove(mesh.group);
      mesh.dispose();
    }
    this.options.onRegion();
  }

  get stats(): StreamingStats {
    let quadBytes = 0;
    let textured = 0;
    for (const mesh of this.drawn.values()) {
      quadBytes += mesh.byteLength;
      if (mesh.region.textures !== undefined) textured += 1;
    }
    return {
      drawn: this.drawn.size,
      textured,
      cached: this.cache.size,
      loading: this.requests.size,
      remaining: this.wanted.length,
      megabytes: this.bytes / (1024 * 1024),
      // Each quad packs into three 32-bit words.
      quads: quadBytes / 12,
    };
  }

  /**
   * Recomputes the drawn set for this camera and starts the most useful requests.
   * `screenHeight` is the height of the drawing buffer in device pixels.
   */
  update(camera: PerspectiveCamera, screenHeight: number): void {
    this.frame += 1;
    this.pixelsPerBlock = screenHeight / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
    this.projectionBlend = camera instanceof ViewCamera ? camera.projectionBlend : 0;
    this.focusDistance = camera instanceof ViewCamera ? camera.focusDistance : 1;
    camera.updateMatrixWorld();
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.matrix);

    const wanted: Wanted[] = [];
    const draw: RegionMesh[] = [];
    const span = regionSpan(this.maxLevel);
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
        this.resolve(node(this.maxLevel, rootX, rootZ), draw, wanted);
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

  /** The nearest drawn surface along a ray, with `radius` blocks of room around the ray. */
  raycast(origin: Vector3, direction: Vector3, far: number, radius = 0): SurfaceHit | undefined {
    let offset = 0;
    if (this.selection) {
      const range = selectedRayRange(this.selection, origin, direction, far);
      if (!range) return undefined;
      offset = range[0];
      origin = origin.clone().addScaledVector(direction, offset);
      far = range[1] - offset;
    }
    const crossed: { readonly mesh: RegionMesh; readonly entry: number }[] = [];
    for (const mesh of this.drawn.values()) {
      const entry = regionEntry(mesh.region, origin, direction, far, radius);
      if (entry < far) crossed.push({ mesh, entry });
    }
    crossed.sort((left, right) => left.entry - right.entry);

    let hit: SurfaceHit | undefined;
    for (const { mesh, entry } of crossed) {
      const reach = hit?.distance ?? far;
      if (entry >= reach) break;
      hit = mesh.collider.raycast(origin, direction, reach, radius) ?? hit;
    }
    return hit === undefined ? undefined : { ...hit, distance: hit.distance + offset };
  }

  /** Height of the highest block at a world column, from the finest region drawn there. */
  heightAt(x: number, z: number): number | undefined {
    if (this.selection && !selectionContains(this.selection, x, z)) return undefined;
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
    this.disposed = true;
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    if (!this.options.explorationRequests) this.explorationRequests.dispose();
    for (const cached of this.cache.values()) cached.mesh?.dispose();
    this.cache.clear();
    this.drawn.clear();
    this.fades.clear();
    this.root.clear();
    this.bytes = 0;
    this.wanted = [];
  }

  /**
   * Adds what should be drawn for `target` to `draw`. Returns whether the whole
   * area is covered, either by the node itself or by all of its descendants.
   */
  private resolve(target: RegionNode, draw: RegionMesh[], wanted: Wanted[]): boolean {
    const span = regionSpan(target.level);
    if (
      this.selection &&
      !selectionIntersects(this.selection, target.x * span, target.z * span, span)
    )
      return true;
    const distance = this.distanceTo(target);
    if (distance > this.viewDistance) return true;
    const cached = this.cache.get(target.key);
    const refine = target.level > 0 && this.refines(target, distance);

    if (!refine) {
      if (cached !== undefined) {
        if (this.projectionBlend <= 0) cached.blended = false;
        return this.use(this.withTextures(target, distance, cached, wanted), draw);
      }
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
    const span = regionSpan(target.level);
    if (
      this.selection &&
      !selectionIntersects(this.selection, target.x * span, target.z * span, span)
    )
      return true;
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

  /** The textured twin of a near level 0 region when it is ready, asking for it otherwise. */
  private withTextures(
    target: RegionNode,
    distance: number,
    cached: CachedRegion,
    wanted: Wanted[],
  ): CachedRegion {
    const textures = this.textures;
    if (textures === undefined || target.level !== 0 || cached.mesh === undefined) return cached;
    const key = `${texturedPrefix(textures)}${target.key}`;
    const textured = this.cache.get(key);
    const pixels = projectedPixels(
      1,
      distance,
      this.pixelsPerBlock,
      this.projectionBlend,
      this.focusDistance,
    );
    // A textured region stays a little past the size that asked for it, so it does not flicker.
    if (pixels < textures.minPixels * (textured === undefined ? 1 : 0.7)) return cached;
    if (textured !== undefined) {
      if (textured.mesh === undefined) return cached;
      cached.lastDrawn = this.frame;
      return textured;
    }
    if (!this.texturedFailures.has(key)) {
      wanted.push({
        node: { ...target, key, textured: true },
        // After the plain regions at the same distance, which fill holes.
        priority: this.priority(target, distance) * 1.5 + 16,
      });
    }
    return cached;
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
    // A region and its textured twin share a key; swapping them dissolves one into the other.
    for (const [key, mesh] of this.drawn) {
      if (next.get(key) !== mesh) this.startFade(mesh, false, now);
    }
    for (const [key, mesh] of next) {
      if (this.drawn.get(key) === mesh) continue;
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
    const params = contextSearch(this.context);
    params.set("revision", this.options.revision);
    const textures = target.textured === true ? this.textures : undefined;
    if (textures !== undefined) {
      params.set("textures", textures.revision);
      if (textures.cutout === true) params.set("cutout", "1");
    }
    const base = this.options.regionBase ?? "/regions";
    const suffix = this.options.regionSuffix ?? "";
    const url = `${base}/${target.level}/${target.x}/${target.z}${suffix}?${params}`;
    this.explorationRequests
      .read(url, controller.signal)
      .then((bytes) => {
        if (this.disposed || controller.signal.aborted) return;
        const region = decodeSceneRegion(new Uint8Array(bytes));
        const materials =
          textures !== undefined && region.textures !== undefined
            ? textures.materials
            : this.options.materials;
        const mesh = new RegionMesh(region, materials, this.options.meshPool);
        if (mesh.isEmpty) {
          mesh.dispose();
          this.store(target, undefined);
        } else this.store(target, mesh);
      })
      .catch((cause: unknown) => {
        if (this.disposed || controller.signal.aborted) return;
        if (target.textured === true) {
          this.texturedFailures.add(target.key);
          if (
            cause instanceof ExplorationRequestError &&
            (cause.status === 409 || cause.status === 400)
          )
            this.options.onStaleTextures?.();
        }
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          console.warn(cause);
        }
      })
      .finally(() => {
        if (this.requests.get(target.key) === controller) this.requests.delete(target.key);
      });
  }

  private store(target: RegionNode, mesh: RegionMesh | undefined): void {
    this.cache.set(target.key, { mesh, lastDrawn: this.frame, blended: this.projectionBlend > 0 });
    this.bytes += mesh?.byteLength ?? 0;
    if (target.level === 0 && target.textured !== true) this.detailRevision++;
    this.options.onRegion();
  }

  private evict(): void {
    // Empty regions cost no quad bytes but still need a bounded metadata cache.
    const maxEntries = this.context.mode === "caves" ? 256 : 8192;
    let textured = 0;
    for (const key of this.cache.keys()) if (key.startsWith("t/")) textured += 1;
    const texturedLimit = TEXTURED_CACHE + this.drawn.size;
    const withinBudget = () =>
      this.bytes <= this.options.memoryBudget * 0.85 && this.cache.size <= maxEntries;
    if (
      this.bytes <= this.options.memoryBudget &&
      this.cache.size <= maxEntries &&
      textured <= texturedLimit
    )
      return;
    const shown = new Set(this.drawn.values());
    const stale = [...this.cache.entries()]
      .filter(
        ([key, { mesh }]) =>
          !this.drawn.has(key) && !(mesh && (shown.has(mesh) || this.fades.has(mesh))),
      )
      .sort(([, left], [, right]) => left.lastDrawn - right.lastDrawn);
    for (const [key, cached] of stale) {
      const isTextured = key.startsWith("t/");
      if (withinBudget()) {
        // Only textured regions above their own limit are left to evict.
        if (textured <= texturedLimit) break;
        if (!isTextured) continue;
      }
      if (isTextured) textured -= 1;

      this.cache.delete(key);
      if (key.startsWith("0/")) this.detailRevision++;
      this.bytes -= cached.mesh?.byteLength ?? 0;
      cached.mesh?.dispose();
    }
    if (this.context.mode === "caves" && this.bytes > this.options.memoryBudget) {
      this.viewDistance = Math.max(32, this.viewDistance * 0.75);
    }
  }

  /**
   * Whether a node's cells would draw larger than the pixel target. An orthographic view draws
   * every distance at nearly one scale, so only nodes in view refine there; nodes outside keep
   * coarse cells for shadows and quick pans.
   */
  private refines(target: RegionNode, distance: number): boolean {
    if (this.projectionBlend <= 0) return distance < this.refineDistance(target.level);
    if (!this.frustum.intersectsBox(this.nodeBox(target))) return false;
    const pixels = target.level === 1 ? this.options.blockPixels : this.options.voxelPixels;
    return (
      projectedPixels(
        regionCellSize(target.level),
        distance,
        this.pixelsPerBlock,
        this.projectionBlend,
        this.focusDistance,
      ) > pixels
    );
  }

  /** Distance at which a node's cells would draw larger than the pixel target. */
  private refineDistance(level: number): number {
    const pixels = level === 1 ? this.options.blockPixels : this.options.voxelPixels;
    return (regionCellSize(level) * this.pixelsPerBlock) / pixels;
  }

  private distanceTo(target: RegionNode): number {
    const span = regionSpan(target.level);
    const entry = this.cache.get(target.key);
    const cached = entry?.blended && this.projectionBlend <= 0 ? undefined : entry?.mesh?.region;
    const { dimension, minY, maxY, mode } = this.context;
    const low =
      mode === "caves"
        ? minY
        : dimension === "overworld"
          ? TYPICAL_LOW
          : DIMENSIONS[dimension].minY;
    const high = mode === "caves" ? maxY : dimension === "overworld" ? TYPICAL_HIGH : maxY;
    this.box.min.set(target.x * span, cached?.minY ?? low, target.z * span);
    this.box.max.set((target.x + 1) * span, cached?.maxY ?? high, (target.z + 1) * span);
    return this.box.distanceToPoint(this.cameraPosition);
  }

  /** Nearer nodes load first; nodes outside the view wait behind visible ones. */
  private priority(target: RegionNode, distance: number): number {
    const span = regionSpan(target.level);
    return this.frustum.intersectsBox(this.nodeBox(target)) ? distance : distance * 3 + span;
  }

  /** A node's column with a margin above and below the typical terrain. */
  private nodeBox(target: RegionNode): Box3 {
    const span = regionSpan(target.level);
    const { dimension, minY, maxY, mode } = this.context;
    this.box.min.set(
      target.x * span,
      mode === "caves"
        ? minY
        : dimension === "overworld"
          ? TYPICAL_LOW - 64
          : DIMENSIONS[dimension].minY,
      target.z * span,
    );
    this.box.max.set(
      (target.x + 1) * span,
      mode === "caves" ? maxY : dimension === "overworld" ? TYPICAL_HIGH + 64 : maxY,
      (target.z + 1) * span,
    );
    return this.box;
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
