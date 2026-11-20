import {
  clusterPoints,
  placeLabels,
  safeImageUrl,
  type Box,
  type LabelRequest,
  type ScreenCluster,
} from "./layout.js";
import { MARKER_STYLE } from "./style.js";

/** A marker given by the host. Mapelix keeps no copy beyond what it draws. */
export interface MarkerInput {
  /** Unique within the viewer. */
  readonly id: string;
  /** Block coordinates; the marker sits at the center of the block. */
  readonly x: number;
  readonly z: number;
  /** Block Y in 3D; without it the marker sits on the drawn terrain. */
  readonly y?: number;
  /** `overworld` (default), `nether` or `the-end` (`end` is accepted). */
  readonly dimension?: string;
  /** Plain text, never read as HTML. */
  readonly label?: string;
  /** One to four characters drawn in the marker, such as a letter or an emoji. */
  readonly icon?: string;
  /** An http(s) or relative image address, drawn in the marker instead of `icon`. */
  readonly image?: string;
  /** Any CSS color. */
  readonly color?: string;
  /** Lets the host show or hide markers together. */
  readonly group?: string;
  /** Higher keeps its place and label first when markers crowd. Default 0. */
  readonly priority?: number;
  /** Host data, given back untouched in events; Mapelix never reads it. */
  readonly data?: unknown;
}

/** A marker as Mapelix kept it after checking its fields. */
export type Marker = Readonly<Omit<MarkerInput, "dimension"> & { dimension: string }>;

export interface MarkerClickEvent {
  readonly marker: Marker;
  readonly mode: "2d" | "3d";
  readonly clientX: number;
  readonly clientY: number;
}

export interface MarkerTexts {
  /** Accessible name of the marker layer. */
  readonly layer: string;
  /** Accessible name of a marker without a label. */
  readonly marker: string;
  /** Accessible name of a group of markers; a press zooms in on it. */
  readonly cluster: (count: number) => string;
}

export const DEFAULT_MARKER_TEXTS: MarkerTexts = {
  layer: "Markers",
  marker: "Marker",
  cluster: (count) => `${count} markers, zoom in`,
};

/** The markers API a host uses; see `MapelixViewer.markers`. */
export interface Markers {
  /** Replaces every marker. */
  set(markers: readonly MarkerInput[]): void;
  /** Adds markers, or replaces those with the same ids. */
  upsert(markers: MarkerInput | readonly MarkerInput[]): void;
  /** Changes fields of one marker; returns false when there is no such marker. */
  update(id: string, patch: Partial<Omit<MarkerInput, "id">>): boolean;
  remove(ids: string | readonly string[]): void;
  clear(): void;
  get(id: string): Marker | undefined;
  list(): Marker[];
  /** Shows or hides every marker of a group. */
  setGroupVisible(group: string, visible: boolean): void;
  isGroupVisible(group: string): boolean;
  /** Highlights a marker and gives its label the first place; `undefined` clears it. */
  select(id: string | undefined): void;
  readonly selected: Marker | undefined;
  /** Called when a marker is tapped, clicked or activated from the keyboard. */
  onClick(listener: (event: MarkerClickEvent) => void): () => void;
  /** Screen areas labels must avoid, such as controls, relative to the viewer element. */
  setObstacles(boxes: readonly Box[]): void;
  /** The single marker drawn under a screen point (not a group), if any. */
  markerAt(clientX: number, clientY: number): Marker | undefined;
}

/** What the layer needs from the viewer, frame by frame. */
export interface MarkerHost {
  readonly mode: () => "2d" | "3d";
  readonly dimension: () => string;
  /** Projects a world point to element pixels; false when it does not show. */
  readonly project: (
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    out: { x: number; y: number },
  ) => boolean;
  /** Terrain height in 3D, or undefined. */
  readonly heightAt: (x: number, z: number) => number | undefined;
  /** Zooms in on a world point, in either mode. */
  readonly zoomToward: (x: number, z: number) => void;
  /** Whether a pointer press landed on the map or the 3D view. */
  readonly isView: (target: EventTarget | null) => boolean;
}

export interface MarkerStats {
  readonly markers: number;
  /** Markers projected inside the view in the last update. */
  readonly visible: number;
  /** Items in the DOM: single markers and groups. */
  readonly elements: number;
  readonly clusters: number;
  readonly labels: number;
  readonly updates: number;
  readonly lastUpdateMs: number;
  readonly maxUpdateMs: number;
}

interface Stored {
  marker: Marker;
  order: number;
  x: number;
  y: number | undefined;
  z: number;
  height: number | undefined;
  heightNext: number;
}

interface Item {
  key: string;
  readonly element: HTMLButtonElement;
  readonly icon: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  /** What was drawn, to touch the DOM only on change. */
  content: string;
  labelText: string;
  x: number;
  y: number;
  labelX: number;
  labelY: number;
  labelShown: boolean;
  selected: boolean;
  /** The marker, or the group's members, for presses. */
  marker: Stored | undefined;
  members: Stored[];
}

/** Pixels between two group leaders; items are about 30 px wide. */
const CLUSTER_RADIUS = 48;
const ITEM_RADIUS = 16;
const HIT_RADIUS = 24;
const MARGIN = 40;
const LABEL_HEIGHT = 22;
const LABEL_MAX_WIDTH = 200;
const LABEL_FONT = "600 13px system-ui, sans-serif";
const MAX_LABELS = 64;
const TAP_SLOP = 10;
/** Shorter than a long press (500 ms), so a long press is never also a tap. */
const TAP_MS = 450;
const FALLBACK_Y = 64;
const HEIGHT_REFRESH = 60;
const HEIGHT_RETRY = 20;
const POOL_SIZE = 64;

function dimensionName(value: unknown): string {
  if (typeof value !== "string" || value === "") return "overworld";
  return value === "end" ? "the-end" : value;
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter() : undefined;

/** Trimmed text of at most `max` characters as people see them (an emoji counts once). */
function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  if (segmenter === undefined) return trimmed.slice(0, max);
  let result = "",
    count = 0;
  for (const { segment } of segmenter.segment(trimmed)) {
    if (count === max) break;
    result += segment;
    count += 1;
  }
  return result;
}

function color(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) return undefined;
  return typeof CSS !== "undefined" && CSS.supports("color", value) ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Checks a host marker: unusable fields are dropped, a marker without id or place is refused. */
export function checkMarker(input: MarkerInput): Marker | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const id = typeof input.id === "string" && input.id !== "" ? input.id : undefined;
  const x = finite(input.x),
    z = finite(input.z);
  if (id === undefined || x === undefined || z === undefined) return undefined;
  const marker: { -readonly [K in keyof Marker]: Marker[K] } = {
    id,
    x,
    z,
    dimension: dimensionName(input.dimension),
  };
  const y = finite(input.y);
  if (y !== undefined) marker.y = y;
  const label = text(input.label, 120);
  if (label !== undefined) marker.label = label;
  const icon = text(input.icon, 4);
  if (icon !== undefined) marker.icon = icon;
  const image = safeImageUrl(input.image);
  if (image !== undefined) marker.image = image;
  const tint = color(input.color);
  if (tint !== undefined) marker.color = tint;
  if (typeof input.group === "string" && input.group !== "") marker.group = input.group;
  const priority = finite(input.priority);
  if (priority !== undefined) marker.priority = priority;
  if ("data" in input) marker.data = input.data;
  return Object.freeze(marker);
}

/**
 * Markers over the map and the 3D view, in one DOM layer: only the markers and groups inside
 * the view exist as elements, moved with transforms; labels go where they overlap nothing.
 * Elements never take pointer events, so a drag that starts on a marker still moves the view;
 * a tap without movement selects the marker under it.
 */
export class MarkerLayer implements Markers {
  readonly root: HTMLDivElement;
  private readonly host: MarkerHost;
  private readonly texts: MarkerTexts;
  private readonly element: HTMLElement;
  private readonly stored = new Map<string, Stored>();
  private sorted: Stored[] = [];
  private nextOrder = 0;
  private sortNeeded = false;
  private readonly hidden = new Set<string>();
  private selectedId: string | undefined;
  private readonly listeners = new Set<(event: MarkerClickEvent) => void>();
  private obstacles: readonly Box[] = [];
  private readonly items = new Map<string, Item>();
  private readonly pool: Item[] = [];
  private readonly widths = new Map<string, number>();
  private measureContext: CanvasRenderingContext2D | null | undefined;
  private width = 1;
  private height = 1;
  private xs = new Float64Array(256);
  private ys = new Float64Array(256);
  private refs: Stored[] = [];
  private readonly point = { x: 0, y: 0 };
  private frame = 0;
  private request = 0;
  private readonly resize: ResizeObserver;
  private press: { id: number; x: number; y: number; time: number; multi: boolean } | undefined;
  private disposed = false;
  private statsNow: { -readonly [K in keyof MarkerStats]: MarkerStats[K] } = {
    markers: 0,
    visible: 0,
    elements: 0,
    clusters: 0,
    labels: 0,
    updates: 0,
    lastUpdateMs: 0,
    maxUpdateMs: 0,
  };

  constructor(element: HTMLElement, host: MarkerHost, texts: Partial<MarkerTexts> = {}) {
    this.element = element;
    this.host = host;
    this.texts = { ...DEFAULT_MARKER_TEXTS, ...texts };
    const document = element.ownerDocument;
    if (!document.querySelector("style[data-mapelix-markers], link[data-mapelix-styles]")) {
      const style = document.createElement("style");
      style.dataset.mapelixMarkers = "";
      style.textContent = MARKER_STYLE;
      document.head.append(style);
    }
    this.root = document.createElement("div");
    this.root.className = "mx-markers";
    this.root.setAttribute("role", "group");
    this.root.setAttribute("aria-label", this.texts.layer);
    this.root.addEventListener("click", this.onKeyboardClick);
    element.append(this.root);
    element.addEventListener("pointerdown", this.onPointerDown, { capture: true, passive: true });
    element.addEventListener("pointerup", this.onPointerUp, { capture: true, passive: true });
    element.addEventListener("pointercancel", this.onPointerCancel, {
      capture: true,
      passive: true,
    });
    element.addEventListener("pointermove", this.onPointerMove, { passive: true });
    this.resize = new ResizeObserver(() => {
      this.width = Math.max(1, element.clientWidth);
      this.height = Math.max(1, element.clientHeight);
      this.schedule();
    });
    this.resize.observe(element);
    this.width = Math.max(1, element.clientWidth);
    this.height = Math.max(1, element.clientHeight);
  }

  // ── Host API ──────────────────────────────────────────────────────────────

  set(markers: readonly MarkerInput[]): void {
    this.stored.clear();
    this.upsert(markers);
    if (this.selectedId !== undefined && !this.stored.has(this.selectedId))
      this.selectedId = undefined;
    this.changed();
  }

  upsert(markers: MarkerInput | readonly MarkerInput[]): void {
    const list: readonly MarkerInput[] = Array.isArray(markers)
      ? (markers as readonly MarkerInput[])
      : [markers as MarkerInput];
    for (const input of list) {
      const marker = checkMarker(input);
      if (marker === undefined) continue;
      const before = this.stored.get(marker.id);
      this.stored.set(marker.id, {
        marker,
        order: before?.order ?? this.nextOrder++,
        x: marker.x + 0.5,
        y: marker.y === undefined ? undefined : marker.y + 0.5,
        z: marker.z + 0.5,
        height:
          before !== undefined && before.marker.x === marker.x && before.marker.z === marker.z
            ? before.height
            : undefined,
        heightNext: 0,
      });
    }
    this.changed();
  }

  update(id: string, patch: Partial<Omit<MarkerInput, "id">>): boolean {
    const before = this.stored.get(id);
    if (before === undefined) return false;
    this.upsert({ ...before.marker, ...patch, id });
    return this.stored.has(id);
  }

  remove(ids: string | readonly string[]): void {
    for (const id of typeof ids === "string" ? [ids] : ids) this.stored.delete(id);
    if (this.selectedId !== undefined && !this.stored.has(this.selectedId))
      this.selectedId = undefined;
    this.changed();
  }

  clear(): void {
    this.stored.clear();
    this.selectedId = undefined;
    this.changed();
  }

  get(id: string): Marker | undefined {
    return this.stored.get(id)?.marker;
  }

  list(): Marker[] {
    return [...this.stored.values()].sort((a, b) => a.order - b.order).map((entry) => entry.marker);
  }

  setGroupVisible(group: string, visible: boolean): void {
    if (visible ? !this.hidden.delete(group) : this.hidden.has(group)) return;
    if (!visible) this.hidden.add(group);
    this.schedule();
  }

  isGroupVisible(group: string): boolean {
    return !this.hidden.has(group);
  }

  select(id: string | undefined): void {
    const next = id !== undefined && this.stored.has(id) ? id : undefined;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this.changed();
  }

  get selected(): Marker | undefined {
    return this.selectedId === undefined ? undefined : this.stored.get(this.selectedId)?.marker;
  }

  onClick(listener: (event: MarkerClickEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setObstacles(boxes: readonly Box[]): void {
    this.obstacles = boxes.map((box) => ({ ...box }));
    this.schedule();
  }

  markerAt(clientX: number, clientY: number): Marker | undefined {
    return this.itemAt(clientX, clientY)?.marker?.marker;
  }

  /** Counters for tests and tuning. */
  stats(): MarkerStats {
    return { ...this.statsNow, markers: this.stored.size };
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.request);
    this.resize.disconnect();
    this.listeners.clear();
    this.element.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    this.element.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    this.element.removeEventListener("pointercancel", this.onPointerCancel, { capture: true });
    this.element.removeEventListener("pointermove", this.onPointerMove);
    this.root.remove();
  }

  // ── Frame update ──────────────────────────────────────────────────────────

  /** Asks for an update on the next animation frame (data or size changes). */
  schedule(): void {
    if (this.request !== 0 || this.disposed) return;
    this.request = requestAnimationFrame(() => {
      this.request = 0;
      this.redraw();
    });
  }

  /** Places every item for the current view; the viewer calls it after each drawn frame. */
  redraw(): void {
    if (this.disposed) return;
    const start = performance.now();
    this.frame += 1;
    if (this.sortNeeded) this.sort();
    const mode = this.host.mode();
    const dimension = this.host.dimension();
    const width = this.width,
      height = this.height;
    let count = 0;
    if (this.xs.length < this.sorted.length) {
      this.xs = new Float64Array(this.sorted.length * 2);
      this.ys = new Float64Array(this.sorted.length * 2);
    }
    const refs = this.refs;
    refs.length = 0;
    for (const entry of this.sorted) {
      const marker = entry.marker;
      if (marker.dimension !== dimension) continue;
      if (marker.group !== undefined && this.hidden.has(marker.group)) continue;
      let y = 0;
      if (mode === "3d") y = entry.y ?? this.terrainY(entry);
      if (!this.host.project(entry.x, y, entry.z, width, height, this.point)) continue;
      const px = this.point.x,
        py = this.point.y;
      if (px < -MARGIN || py < -MARGIN || px > width + MARGIN || py > height + MARGIN) continue;
      this.xs[count] = px;
      this.ys[count] = py;
      refs.push(entry);
      count += 1;
    }
    const clusters = clusterPoints(this.xs, this.ys, count, CLUSTER_RADIUS);
    this.draw(clusters, refs, width, height);
    const spent = performance.now() - start;
    const stats = this.statsNow;
    stats.visible = count;
    stats.clusters = clusters.filter((cluster) => cluster.members.length > 1).length;
    stats.updates += 1;
    stats.lastUpdateMs = spent;
    stats.maxUpdateMs = Math.max(stats.maxUpdateMs, spent);
  }

  /** Clears the slowest update seen, for a new measurement. */
  resetStats(): void {
    this.statsNow.maxUpdateMs = 0;
    this.statsNow.updates = 0;
  }

  /** Terrain height under a marker, read again now and then (each read walks the regions). */
  private terrainY(entry: Stored): number {
    if (this.frame >= entry.heightNext) {
      const height = this.host.heightAt(Math.floor(entry.x), Math.floor(entry.z));
      if (height !== undefined) entry.height = height;
      // Spread the reads over frames; a column not drawn yet is tried again sooner.
      entry.heightNext =
        this.frame + (height === undefined ? HEIGHT_RETRY : HEIGHT_REFRESH) + (entry.order % 8);
    }
    return entry.height === undefined ? FALLBACK_Y : entry.height + 1;
  }

  private draw(clusters: ScreenCluster[], refs: Stored[], width: number, height: number): void {
    const wanted = new Map<string, { cluster: ScreenCluster; entry: Stored }>();
    for (const cluster of clusters) {
      const leader = refs[cluster.leader]!;
      const single = cluster.members.length === 1;
      wanted.set(single ? `m:${leader.marker.id}` : `c:${leader.marker.id}`, {
        cluster,
        entry: leader,
      });
    }
    // Items gone from the view return to the pool.
    for (const [key, item] of this.items)
      if (!wanted.has(key)) {
        this.items.delete(key);
        item.element.remove();
        item.marker = undefined;
        item.members = [];
        if (this.pool.length < POOL_SIZE) this.pool.push(item);
      }
    const requests: (LabelRequest | undefined)[] = [];
    const placed: Item[] = [];
    const centers: { x: number; y: number }[] = [];
    let labels = 0;
    for (const [key, { cluster, entry }] of wanted) {
      let item = this.items.get(key);
      if (item === undefined) {
        item = this.pool.pop() ?? this.createItem(key);
        item.key = key;
        item.content = "";
        item.labelText = "";
        item.x = Number.NaN;
        this.items.set(key, item);
        this.root.append(item.element);
      }
      const single = cluster.members.length === 1;
      item.marker = single ? entry : undefined;
      item.members = cluster.members.map((index) => refs[index]!);
      this.paint(item, entry.marker, single ? undefined : cluster.members.length);
      this.move(item, cluster.x, cluster.y);
      const selected = single && entry.marker.id === this.selectedId;
      if (selected !== item.selected) {
        item.selected = selected;
        item.element.toggleAttribute("aria-current", selected);
      }
      const label = single ? entry.marker.label : undefined;
      if (label !== undefined && labels < MAX_LABELS) {
        labels += 1;
        requests.push({
          x: cluster.x,
          y: cluster.y,
          width: this.labelWidth(label),
          height: LABEL_HEIGHT,
        });
      } else requests.push(undefined);
      placed.push(item);
      centers.push({ x: cluster.x, y: cluster.y });
    }
    const placements = placeLabels(requests, centers, ITEM_RADIUS, this.obstacles, width, height);
    let shown = 0;
    placed.forEach((item, index) => {
      const placement = placements[index];
      const label = item.marker?.marker.label;
      if (placement === undefined || label === undefined) {
        if (item.labelShown) {
          item.labelShown = false;
          item.label.style.visibility = "hidden";
        }
        return;
      }
      shown += 1;
      if (item.labelText !== label) {
        item.labelText = label;
        item.label.textContent = label;
      }
      if (!item.labelShown) {
        item.labelShown = true;
        item.label.style.visibility = "";
      }
      if (
        !(Math.abs(item.labelX - placement.dx) <= 0.25) ||
        !(Math.abs(item.labelY - placement.dy) <= 0.25)
      ) {
        item.labelX = placement.dx;
        item.labelY = placement.dy;
        item.label.style.transform = `translate(${placement.dx}px, ${placement.dy}px)`;
      }
    });
    this.statsNow.elements = this.items.size;
    this.statsNow.labels = shown;
  }

  private createItem(key: string): Item {
    const document = this.element.ownerDocument;
    const element = document.createElement("button");
    element.type = "button";
    element.className = "mx-marker";
    const icon = document.createElement("span");
    icon.className = "mx-marker-icon";
    const label = document.createElement("span");
    label.className = "mx-marker-label";
    label.style.visibility = "hidden";
    label.setAttribute("aria-hidden", "true");
    element.append(icon, label);
    return {
      key,
      element,
      icon,
      label,
      content: "",
      labelText: "",
      x: Number.NaN,
      y: Number.NaN,
      labelX: Number.NaN,
      labelY: Number.NaN,
      labelShown: false,
      selected: false,
      marker: undefined,
      members: [],
    };
  }

  /** Draws a marker's icon, image and color, or a group's count, only when they change. */
  private paint(item: Item, marker: Marker, count: number | undefined): void {
    const groupColor =
      count === undefined || item.members.every((other) => other.marker.group === marker.group)
        ? marker.color
        : undefined;
    const content =
      count === undefined
        ? `m\u0000${marker.icon ?? ""}\u0000${marker.image ?? ""}\u0000${marker.color ?? ""}\u0000${marker.label ?? ""}`
        : `c\u0000${count}\u0000${groupColor ?? ""}`;
    if (content === item.content) return;
    item.content = content;
    const { element, icon } = item;
    element.dataset.kind = count === undefined ? "marker" : "cluster";
    if (groupColor !== undefined) element.style.setProperty("--mx-marker", groupColor);
    else element.style.removeProperty("--mx-marker");
    icon.replaceChildren();
    if (count !== undefined) {
      icon.textContent = count > 99 ? "99+" : String(count);
      element.setAttribute("aria-label", this.texts.cluster(count));
    } else {
      if (marker.image !== undefined) {
        const image = element.ownerDocument.createElement("img");
        image.alt = "";
        image.decoding = "async";
        image.draggable = false;
        image.referrerPolicy = "no-referrer";
        image.src = marker.image;
        icon.append(image);
      } else if (marker.icon !== undefined) icon.textContent = marker.icon;
      element.setAttribute("aria-label", marker.label ?? this.texts.marker);
    }
  }

  private move(item: Item, x: number, y: number): void {
    if (Math.abs(item.x - x) < 0.1 && Math.abs(item.y - y) < 0.1) return;
    item.x = x;
    item.y = y;
    item.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  private labelWidth(label: string): number {
    let width = this.widths.get(label);
    if (width === undefined) {
      if (this.measureContext === undefined) {
        this.measureContext = this.element.ownerDocument.createElement("canvas").getContext("2d");
        if (this.measureContext) this.measureContext.font = LABEL_FONT;
      }
      const measured = this.measureContext?.measureText(label).width ?? label.length * 7.5;
      width = Math.min(LABEL_MAX_WIDTH, Math.ceil(measured) + 16);
      if (this.widths.size > 4096) this.widths.clear();
      this.widths.set(label, width);
    }
    return width;
  }

  private sort(): void {
    this.sortNeeded = false;
    const selected = this.selectedId;
    this.sorted = [...this.stored.values()].sort(
      (a, b) =>
        Number(b.marker.id === selected) - Number(a.marker.id === selected) ||
        (b.marker.priority ?? 0) - (a.marker.priority ?? 0) ||
        a.order - b.order,
    );
  }

  private changed(): void {
    this.sortNeeded = true;
    this.schedule();
  }

  // ── Presses ───────────────────────────────────────────────────────────────

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.press !== undefined) {
      this.press.multi = true;
      return;
    }
    if (!event.isPrimary || event.button !== 0 || !this.host.isView(event.target)) return;
    this.press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      multi: false,
    };
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.press?.id === event.pointerId) this.press = undefined;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const press = this.press;
    if (press === undefined || press.id !== event.pointerId) return;
    this.press = undefined;
    if (
      press.multi ||
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > TAP_SLOP ||
      performance.now() - press.time > TAP_MS
    )
      return;
    const item = this.itemAt(event.clientX, event.clientY);
    if (item === undefined) {
      this.select(undefined);
      return;
    }
    this.activate(item, event.clientX, event.clientY);
  };

  /** A mouse over a marker shows the hand cursor. */
  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== "mouse" || event.buttons !== 0) return;
    const over = this.itemAt(event.clientX, event.clientY) !== undefined;
    this.element.style.cursor = over ? "pointer" : "";
  };

  /** Enter or Space on a focused marker (pointer presses never reach the elements). */
  private readonly onKeyboardClick = (event: MouseEvent): void => {
    const element = (event.target as Element | null)?.closest?.(".mx-marker");
    if (!element) return;
    for (const item of this.items.values())
      if (item.element === element) {
        const bounds = this.element.getBoundingClientRect();
        this.activate(item, bounds.left + item.x, bounds.top + item.y);
        return;
      }
  };

  private itemAt(clientX: number, clientY: number): Item | undefined {
    const bounds = this.element.getBoundingClientRect();
    const x = clientX - bounds.left,
      y = clientY - bounds.top;
    let best: Item | undefined;
    let bestDistance = HIT_RADIUS * HIT_RADIUS;
    for (const item of this.items.values()) {
      const distance = (item.x - x) ** 2 + (item.y - y) ** 2;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    return best;
  }

  private activate(item: Item, clientX: number, clientY: number): void {
    const entry = item.marker;
    if (entry === undefined) {
      const leader = item.members[0];
      if (leader !== undefined) this.host.zoomToward(leader.marker.x, leader.marker.z);
      return;
    }
    this.select(entry.marker.id);
    const event: MarkerClickEvent = {
      marker: entry.marker,
      mode: this.host.mode(),
      clientX,
      clientY,
    };
    for (const listener of this.listeners) listener(event);
  }
}
