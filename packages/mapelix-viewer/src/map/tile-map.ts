import {
  VelocityTracker,
  TapDetector,
  INERTIA_MIN_SPEED,
  easeOut,
  glide,
  wheelFactor,
} from "./map-input.js";
import { TileIndex } from "./tile-index.js";
import {
  ancestorSource,
  levelFor,
  panBy,
  pinch,
  tileRect,
  visibleTiles,
  zoomAround,
  type MapView,
  type PixelRect,
  type TileAddress,
} from "./tile-math.js";

export interface TileMapOptions {
  /** The published tiles; see `TileIndex.load`. */
  readonly index: TileIndex;
  /** Dimension to show (default: the first one with tiles). */
  readonly dimension?: string;
  /** Initial view; defaults to the middle of the dimension at its native scale. */
  readonly view?: Partial<MapView>;
  /** Zoom limits in CSS pixels per block (defaults: half the coarsest tiles, and 32). */
  readonly minPixelsPerBlock?: number;
  readonly maxPixelsPerBlock?: number;
  /** Decoded tiles kept in memory (default 256, about 64 MiB). */
  readonly maxCachedTiles?: number;
  /** Tile requests in flight (default 6). */
  readonly maxRequests?: number;
  /** Color behind tiles and in unexplored areas. */
  readonly background?: string;
  /** Accessible name of the map; the host provides it in its language. */
  readonly label?: string;
  /** Called when every tile the view needs is drawn, like a tile layer's "load" event. */
  readonly onIdle?: () => void;
  /** Called when the map comes to rest: no finger or button down, no animation or glide. */
  readonly onRest?: (view: MapView) => void;
  /** Called once per frame in which the view changed. */
  readonly onViewChange?: (view: MapView) => void;
}

export interface TileMapStats {
  /** Tiles the current view needs at its zoom level. */
  readonly wanted: number;
  /** Of those, the tiles not drawn yet. */
  readonly pending: number;
  readonly loading: number;
  readonly cached: number;
  readonly level: number;
}

interface Loading {
  readonly controller: AbortController;
}

interface Animation {
  readonly start: number;
  readonly duration: number;
  readonly from: MapView;
  /** Returns the view at eased progress `t`. */
  readonly at: (t: number) => MapView;
}

const KEY_STEP = 0.25;

/**
 * A 2D tile map on a canvas: one-finger drag with inertia, pinch around the fingers,
 * double-tap and double-click zoom, animated wheel zoom, arrow and +/− keys. Tiles load from
 * the center outward, requests that leave the screen are cancelled, decoded tiles are
 * bounded, and tile edges are rounded to device pixels so there are no seams.
 */
export class TileMap {
  readonly element: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private index: TileIndex;
  private dimensionName: string;
  private current: MapView;
  private readonly options: TileMapOptions;
  private minScale: number;
  private readonly maxScale: number;
  private readonly cache = new Map<string, ImageBitmap>();
  private readonly loading = new Map<string, Loading>();
  private readonly failed = new Set<string>();
  private width = 1;
  private height = 1;
  private ratio = 1;
  private frameRequest = 0;
  private dirty = true;
  private viewChanged = true;
  private lastFrame = 0;
  private animation: Animation | undefined;
  private wheel: { target: number; x: number; y: number } | undefined;
  private velocity: { x: number; y: number } | undefined;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: { id: number; x: number; y: number; downAt: number; moved: number } | undefined;
  private pinchStart: { view: MapView; x: number; y: number; distance: number } | undefined;
  private readonly tracker = new VelocityTracker();
  private readonly taps = new TapDetector();
  private readonly resizeObserver: ResizeObserver;
  private stats: TileMapStats = { wanted: 0, pending: 0, loading: 0, cached: 0, level: 0 };
  private disposed = false;
  private active = false;

  constructor(element: HTMLElement, options: TileMapOptions) {
    this.element = element;
    this.options = options;
    this.index = options.index;
    this.dimensionName = options.dimension ?? this.index.dimensions[0] ?? "overworld";
    const zooms = this.index.zooms(this.dimensionName);
    this.minScale = options.minPixelsPerBlock ?? 2 ** (zooms[0] ?? -4) / 2;
    this.maxScale = options.maxPixelsPerBlock ?? 32;
    this.current = this.clampView({ ...this.home(), ...options.view });

    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", options.label ?? "Map");
    Object.assign(this.canvas.style, {
      display: "block",
      width: "100%",
      height: "100%",
      touchAction: "none",
      userSelect: "none",
      webkitUserSelect: "none",
      outline: "none",
    });
    const context = this.canvas.getContext("2d", { alpha: false });
    if (context === null) throw new Error("Canvas 2D is not available");
    this.context = context;
    element.append(this.canvas);
    if (!element.hasAttribute("tabindex")) element.tabIndex = 0;
    element.style.touchAction = "none";
    element.style.overscrollBehavior = "contain";

    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    this.canvas.addEventListener("pointermove", this.onPointerMove);
    this.canvas.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("pointercancel", this.onPointerUp);
    this.canvas.addEventListener("lostpointercapture", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.canvas.addEventListener("contextmenu", this.prevent);
    // Safari's own page zoom gestures.
    element.addEventListener("gesturestart", this.prevent);
    element.addEventListener("gesturechange", this.prevent);
    element.addEventListener("keydown", this.onKeyDown);
    this.resizeObserver = new ResizeObserver(() => this.invalidate());
    this.resizeObserver.observe(element);
    // Draw at once rather than on the next frame, so tile requests start without waiting.
    this.resize();
    this.draw();
    this.dirty = false;
    this.viewChanged = true;
    this.frameRequest = requestAnimationFrame(this.frame);
  }

  /** Loads the manifest at `manifestUrl` and opens a map on it. */
  static async create(
    element: HTMLElement,
    manifestUrl: string | URL,
    options: Omit<TileMapOptions, "index"> = {},
  ): Promise<TileMap> {
    return new TileMap(element, { ...options, index: await TileIndex.load(manifestUrl) });
  }

  get view(): MapView {
    return this.current;
  }

  get dimension(): string {
    return this.dimensionName;
  }

  get dimensions(): string[] {
    return this.index.dimensions;
  }

  get generation(): string {
    return this.index.generation;
  }

  /** Scale limits in CSS pixels per block. */
  get scaleLimits(): { readonly min: number; readonly max: number } {
    return { min: this.minScale, max: this.maxScale };
  }

  /** A gesture, animation or glide is under way. */
  get interacting(): boolean {
    return (
      this.pointers.size > 0 ||
      this.animation !== undefined ||
      this.wheel !== undefined ||
      this.velocity !== undefined
    );
  }

  snapshot(): TileMapStats {
    return this.stats;
  }

  /** Moves to `view`, animated unless `animate` is false. */
  setView(view: Partial<MapView>, animate = true): void {
    const target = this.clampView({ ...this.current, ...view });
    this.stopMotion();
    if (!animate) return this.apply(target);
    const from = this.current;
    const ratio = target.pixelsPerBlock / from.pixelsPerBlock;
    this.active = true;
    this.animation = {
      start: performance.now(),
      duration: 350,
      from,
      at: (t) => ({
        x: from.x + (target.x - from.x) * t,
        z: from.z + (target.z - from.z) * t,
        pixelsPerBlock: from.pixelsPerBlock * ratio ** t,
      }),
    };
    this.invalidate();
  }

  /** Zooms by `factor` around a point in CSS pixels (default: the center), animated. */
  zoomBy(factor: number, x = this.width / 2, y = this.height / 2): void {
    const from = this.current;
    const scale = this.clampScale(from.pixelsPerBlock * factor);
    this.stopMotion();
    this.active = true;
    this.animation = {
      start: performance.now(),
      duration: 250,
      from,
      at: (t) =>
        zoomAround(
          from,
          from.pixelsPerBlock * (scale / from.pixelsPerBlock) ** t,
          this.width,
          this.height,
          x,
          y,
        ),
    };
    this.invalidate();
  }

  /** Shows another dimension of the same export, at its middle. */
  setDimension(dimension: string): void {
    if (dimension !== this.dimensionName) this.setSource(this.index, dimension);
  }

  /** Shows another dimension, or another publication of the same export. */
  setSource(index: TileIndex, dimension = this.dimensionName, view?: Partial<MapView>): void {
    const changedDimension = dimension !== this.dimensionName;
    this.index = index;
    this.dimensionName = dimension;
    const zooms = index.zooms(dimension);
    this.minScale = this.options.minPixelsPerBlock ?? 2 ** (zooms[0] ?? -4) / 2;
    for (const loading of this.loading.values()) loading.controller.abort();
    this.loading.clear();
    this.failed.clear();
    if (changedDimension) this.clearCache();
    this.stopMotion();
    this.apply(this.clampView({ ...(changedDimension ? this.home() : this.current), ...view }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.frameRequest);
    this.resizeObserver.disconnect();
    for (const loading of this.loading.values()) loading.controller.abort();
    this.loading.clear();
    this.clearCache();
    this.element.removeEventListener("gesturestart", this.prevent);
    this.element.removeEventListener("gesturechange", this.prevent);
    this.element.removeEventListener("keydown", this.onKeyDown);
    this.canvas.remove();
  }

  private home(): MapView {
    const extent = this.index.extent(this.dimensionName);
    const zooms = this.index.zooms(this.dimensionName);
    const native = zooms.includes(0) ? 1 : 2 ** (zooms[zooms.length - 1] ?? 0);
    if (extent === undefined) return { x: 0, z: 0, pixelsPerBlock: native };
    return {
      x: (extent[0] + extent[2]) / 2,
      z: (extent[1] + extent[3]) / 2,
      pixelsPerBlock: native,
    };
  }

  private clampScale(scale: number): number {
    return Math.min(Math.max(scale, this.minScale), this.maxScale);
  }

  private clampView(view: MapView): MapView {
    return { x: view.x, z: view.z, pixelsPerBlock: this.clampScale(view.pixelsPerBlock) };
  }

  private apply(view: MapView): void {
    this.current = view;
    this.viewChanged = true;
    this.invalidate();
  }

  private stopMotion(): void {
    this.animation = undefined;
    this.wheel = undefined;
    this.velocity = undefined;
  }

  private invalidate(): void {
    this.dirty = true;
    if (this.frameRequest === 0 && !this.disposed)
      this.frameRequest = requestAnimationFrame(this.frame);
  }

  private resize(): void {
    const bounds = this.element.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(bounds.width, 1),
      height = Math.max(bounds.height, 1);
    const pixelWidth = Math.max(Math.round(width * ratio), 1),
      pixelHeight = Math.max(Math.round(height * ratio), 1);
    if (pixelWidth !== this.canvas.width || pixelHeight !== this.canvas.height) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.width = width;
    this.height = height;
    this.ratio = ratio;
  }

  private readonly frame = (now: number): void => {
    this.frameRequest = 0;
    if (this.disposed) return;
    const dt = this.lastFrame === 0 ? 16 : Math.min(now - this.lastFrame, 100);
    this.lastFrame = now;
    let moving = false;
    if (this.animation !== undefined) {
      const t = (now - this.animation.start) / this.animation.duration;
      this.current = this.animation.at(easeOut(t));
      this.viewChanged = true;
      if (t >= 1) this.animation = undefined;
      else moving = true;
    }
    if (this.wheel !== undefined) {
      const { target, x, y } = this.wheel;
      const scale = this.current.pixelsPerBlock;
      // Approach the target scale in log space, about 90 % in 120 ms.
      const next = scale * (target / scale) ** (1 - Math.exp(-dt / 50));
      const done = Math.abs(Math.log(target / next)) < 0.002;
      this.current = zoomAround(this.current, done ? target : next, this.width, this.height, x, y);
      this.viewChanged = true;
      if (done) this.wheel = undefined;
      else moving = true;
    }
    if (this.velocity !== undefined) {
      const step = glide(this.velocity, dt);
      this.current = panBy(this.current, step.dx, step.dy);
      this.viewChanged = true;
      this.velocity =
        Math.hypot(step.velocity.x, step.velocity.y) < INERTIA_MIN_SPEED / 4
          ? undefined
          : step.velocity;
      moving ||= this.velocity !== undefined;
    }
    if (this.dirty || moving) {
      this.dirty = false;
      this.resize();
      this.draw();
    }
    if (this.viewChanged) {
      this.viewChanged = false;
      this.options.onViewChange?.(this.current);
    }
    if (moving) this.invalidate();
    const active = this.interacting;
    if (this.active && !active) this.options.onRest?.(this.current);
    this.active = active;
  };

  private key(tile: TileAddress): string {
    return `${this.dimensionName}/${tile.z}/${tile.x}/${tile.y}`;
  }

  private draw(): void {
    const { canvas, context, current: view, ratio } = this;
    const zooms = this.index.zooms(this.dimensionName);
    context.fillStyle = this.options.background ?? "#1b1d22";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (zooms.length === 0) {
      this.stats = { wanted: 0, pending: 0, loading: 0, cached: this.cache.size, level: 0 };
      return;
    }
    const level = levelFor(view.pixelsPerBlock, ratio, zooms);
    const wanted = visibleTiles(view, this.width, this.height, level).filter(
      (tile) => this.index.url(this.dimensionName, tile) !== undefined,
    );
    const wantedKeys = new Set(wanted.map((tile) => this.key(tile)));
    // A ring around the screen loads after it, so short drags show ready tiles.
    const ring = visibleTiles(view, this.width, this.height, level, 1).filter(
      (tile) =>
        !wantedKeys.has(this.key(tile)) && this.index.url(this.dimensionName, tile) !== undefined,
    );
    const keep = new Set([...wantedKeys, ...ring.map((tile) => this.key(tile))]);
    for (const [key, loading] of this.loading)
      if (!keep.has(key)) {
        loading.controller.abort();
        this.loading.delete(key);
      }

    let pending = 0;
    for (const tile of wanted) {
      const rect = tileRect(view, canvas.width, canvas.height, ratio, tile);
      const bitmap = this.use(tile);
      if (bitmap !== undefined) this.blit(bitmap, 0, 0, bitmap.width, rect);
      else {
        pending += this.failed.has(this.key(tile)) ? 0 : 1;
        this.drawFallback(tile, rect, zooms);
      }
    }
    for (const tile of [...wanted, ...ring]) {
      if (this.loading.size >= (this.options.maxRequests ?? 6)) break;
      const key = this.key(tile);
      if (!this.cache.has(key) && !this.loading.has(key) && !this.failed.has(key)) this.load(tile);
    }
    this.evict(keep);
    const wasPending = this.stats.pending > 0 || this.stats.wanted === 0;
    if (pending === 0 && wanted.length > 0 && wasPending) this.options.onIdle?.();
    this.stats = {
      wanted: wanted.length,
      pending,
      loading: this.loading.size,
      cached: this.cache.size,
      level,
    };
  }

  /** Draws a coarser cached tile, enlarged, or finer cached tiles, shrunk, while a tile loads. */
  private drawFallback(tile: TileAddress, rect: PixelRect, zooms: readonly number[]): void {
    for (let zoom = tile.z - 1; zoom >= (zooms[0] ?? tile.z); zoom -= 1) {
      const source = ancestorSource(tile, zoom);
      const bitmap = this.cache.get(this.key(source.tile));
      if (bitmap !== undefined) {
        this.blit(bitmap, source.sx, source.sy, source.size, rect);
        return;
      }
    }
    if (!zooms.includes(tile.z + 1)) return;
    const midX = Math.round((rect.left + rect.right) / 2),
      midY = Math.round((rect.top + rect.bottom) / 2);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      const child = this.cache.get(
        this.key({ z: tile.z + 1, x: tile.x * 2 + dx, y: tile.y * 2 + dy }),
      );
      if (child === undefined) continue;
      this.blit(child, 0, 0, child.width, {
        left: dx === 0 ? rect.left : midX,
        top: dy === 0 ? rect.top : midY,
        right: dx === 0 ? midX : rect.right,
        bottom: dy === 0 ? midY : rect.bottom,
      });
    }
  }

  /** Enlarged pixels stay sharp; shrunk tiles are filtered. */
  private blit(bitmap: ImageBitmap, sx: number, sy: number, size: number, rect: PixelRect): void {
    const width = rect.right - rect.left,
      height = rect.bottom - rect.top;
    if (width <= 0 || height <= 0) return;
    const enlarged = width > size * 1.001;
    this.context.imageSmoothingEnabled = !enlarged;
    if (!enlarged) this.context.imageSmoothingQuality = "high";
    this.context.drawImage(bitmap, sx, sy, size, size, rect.left, rect.top, width, height);
  }

  private use(tile: TileAddress): ImageBitmap | undefined {
    const key = this.key(tile);
    const bitmap = this.cache.get(key);
    if (bitmap !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, bitmap);
    }
    return bitmap;
  }

  private load(tile: TileAddress): void {
    const url = this.index.url(this.dimensionName, tile);
    if (url === undefined) return;
    const key = this.key(tile);
    const controller = new AbortController();
    this.loading.set(key, { controller });
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Tile ${response.status}`);
        return createImageBitmap(await response.blob());
      })
      .then(
        (bitmap) => {
          if (controller.signal.aborted || this.disposed) return bitmap.close();
          this.cache.set(key, bitmap);
        },
        () => {
          if (!controller.signal.aborted) this.failed.add(key);
        },
      )
      .finally(() => {
        if (this.loading.get(key)?.controller === controller) this.loading.delete(key);
        this.invalidate();
      });
  }

  private evict(keep: ReadonlySet<string>): void {
    const limit = Math.max(this.options.maxCachedTiles ?? 256, keep.size);
    for (const [key, bitmap] of this.cache) {
      if (this.cache.size <= limit) break;
      if (keep.has(key)) continue;
      bitmap.close();
      this.cache.delete(key);
    }
  }

  private clearCache(): void {
    for (const bitmap of this.cache.values()) bitmap.close();
    this.cache.clear();
  }

  private local(event: PointerEvent | WheelEvent): { x: number; y: number } {
    const bounds = this.canvas.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  private startPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (a === undefined || b === undefined) return;
    this.pinchStart = {
      view: this.current,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
    this.drag = undefined;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    this.element.focus({ preventScroll: true });
    this.canvas.setPointerCapture(event.pointerId);
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);
    this.stopMotion();
    this.active = true;
    if (this.pointers.size === 1) {
      this.drag = { id: event.pointerId, ...point, downAt: event.timeStamp, moved: 0 };
      this.tracker.reset(event.timeStamp, point.x, point.y);
    } else if (this.pointers.size === 2) this.startPinch();
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);
    if (this.pinchStart !== undefined && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      this.apply(
        pinch(
          this.pinchStart.view,
          this.width,
          this.height,
          this.pinchStart,
          {
            x: (a!.x + b!.x) / 2,
            y: (a!.y + b!.y) / 2,
            distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
          },
          (scale) => this.clampScale(scale),
        ),
      );
      return;
    }
    const drag = this.drag;
    if (drag === undefined || drag.id !== event.pointerId) return;
    const dx = point.x - drag.x,
      dy = point.y - drag.y;
    drag.x = point.x;
    drag.y = point.y;
    drag.moved += Math.hypot(dx, dy);
    this.tracker.add(event.timeStamp, point.x, point.y);
    this.apply(panBy(this.current, dx, dy));
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    // The next frame reports the rest once nothing moves any more.
    this.invalidate();
    if (this.pinchStart !== undefined) {
      if (this.pointers.size >= 2) return this.startPinch();
      this.pinchStart = undefined;
      // The finger left on the screen carries on dragging from where it is.
      const [id, point] = [...this.pointers.entries()][0] ?? [];
      if (id !== undefined && point !== undefined) {
        this.drag = { id, ...point, downAt: -Infinity, moved: Infinity };
        this.tracker.reset(event.timeStamp, point.x, point.y);
      }
      return;
    }
    const drag = this.drag;
    if (drag === undefined || drag.id !== event.pointerId) return;
    this.drag = undefined;
    if (event.type !== "pointerup") return;
    const point = this.local(event);
    if (this.taps.release(drag.downAt, event.timeStamp, drag.moved, point.x, point.y)) {
      this.zoomBy(2, point.x, point.y);
      return;
    }
    const velocity = this.tracker.velocity(event.timeStamp);
    if (Math.hypot(velocity.x, velocity.y) >= INERTIA_MIN_SPEED) {
      this.velocity = velocity;
      this.invalidate();
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = this.local(event);
    const factor = wheelFactor(event.deltaY, event.deltaMode, event.ctrlKey);
    this.animation = undefined;
    this.velocity = undefined;
    const base = this.wheel?.target ?? this.current.pixelsPerBlock;
    this.wheel = { target: this.clampScale(base * factor), ...point };
    this.active = true;
    this.invalidate();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const step = Math.min(this.width, this.height) * KEY_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (move !== undefined) {
      const target = panBy(this.current, move[0], move[1]);
      this.setView(target);
    } else if (event.key === "+" || event.key === "=") this.zoomBy(2);
    else if (event.key === "-" || event.key === "_") this.zoomBy(0.5);
    else return;
    event.preventDefault();
  };

  private readonly prevent = (event: Event): void => event.preventDefault();
}
