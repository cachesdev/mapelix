import { CAVE_LIMITS, DIMENSIONS, parseDimension } from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_CATEGORIES,
  DISCOVERY_KINDS,
  type DiscoveryGroup,
} from "@mapelix/scene-prototype/discoveries";
import type { MapelixViewer, WorldSettings, WorldStatus } from "../viewer/mapelix-viewer.js";
import type { ViewState } from "../viewer/view-state.js";
import { MarkerEditor, type EditorSurface, type MarkerEditorOptions } from "./marker-editor.js";
import { DEFAULT_MARKER_EDITOR_TEXTS } from "./marker-editor-texts.js";
import { CONTROL_STYLE } from "./style.js";
import { DEFAULT_CONTROL_TEXTS, type ControlTexts } from "./texts.js";

export interface ViewerControlsOptions {
  /** Texts; missing ones fall back to English. */
  readonly texts?: Partial<ControlTexts>;
  /** Force a colour scheme; by default it follows the system. */
  readonly theme?: "light" | "dark";
  /** Show the first-use hint for this many ms (0 hides it; default 9000). */
  readonly hintMs?: number;
  /**
   * The marker editor. By default a tap on a marker shows its card, read-only; pass options to
   * let people add, change and delete markers (the host saves them), or `false` for no card.
   */
  readonly markers?: MarkerEditorOptions | false;
}

/** Below this width the panel and the discovery card share the space and take it all. */
const NARROW = 720;
/** Below this height the button columns fold into two columns. */
const SHORT = 520;

const ICONS = {
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  iso: "m12 3 8 4.6v8.8L12 21l-8-4.6V7.6Zm-8 4.6 8 4.6 8-4.6M12 12.2V21",
  persp: "M8 4h8l4.5 16h-17ZM3.5 20l8.5-6 8.5 6M12 14V4",
  home: "M4 11 12 4l8 7M6 9.5V20h12V9.5M10 20v-5h4v5",
  layers: "M12 3 2 8l10 5 10-5-10-5Zm-8 9 8 4 8-4M4 16l8 4 8-4",
  settings: "M4 7h10M18 7h2M4 17h4M12 17h8M14 4.5v5M8 14.5v5",
  close: "M6 6l12 12M18 6 6 18",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  recover: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  addMarker: "M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11ZM12 7v6M9 10h6",
};

const SVG = "http://www.w3.org/2000/svg";

function icon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(SVG, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

let styleInstalled = false;

/**
 * Ready-made controls for a `MapelixViewer`, framework-free. They only call the viewer API and
 * follow `viewer.subscribe`, so a host may use them, restyle them, or replace them with its own.
 * One layout serves the map and the 3D world; controls without meaning in the current mode
 * keep their place, hidden, so nothing moves when the view switches.
 */
export class ViewerControls {
  readonly root: HTMLDivElement;
  private readonly viewer: MapelixViewer;
  private readonly t: ControlTexts;
  private readonly unsubscribe: () => void;
  private readonly resize: ResizeObserver;
  private openPanel: "settings" | "dimensions" | "marker" | undefined;
  private sheetClosed: (() => void) | undefined;
  private markerCard: { readonly onClosed: () => void } | undefined;
  private prompt: string | undefined;
  private keyboard = 0;
  private readonly editor: MarkerEditor | undefined;
  private panelOpener: HTMLElement | undefined;
  private hintTimer = 0;
  private obstacleRequest = 0;
  private obstacleKey = "";
  private hintShown: boolean;
  private lastGroups = "";
  private cardGroup: DiscoveryGroup | undefined;
  private cardDismissed: DiscoveryGroup | undefined;
  private holding: number | undefined;
  private state!: { view: ViewState; status: WorldStatus; settings: WorldSettings };
  // Elements updated on every change.
  private readonly readoutPosition = make("span");
  private readonly readoutScale = make("span", "mx-scale");
  private readonly readoutNote = make("span", "mx-note");
  private readonly progress = make("div", "mx-progress");
  private readonly compass: HTMLButtonElement;
  private readonly compassIcon: SVGSVGElement;
  private readonly projectionButton: HTMLButtonElement;
  private readonly modeButton: HTMLButtonElement;
  private readonly caveGroup = make("div", "mx-caves");
  private readonly settingsButton: HTMLButtonElement;
  private readonly dimensionButton: HTMLButtonElement;
  private readonly panel = make("div", "mx-panel");
  private readonly panelTitle = make("h2");
  private readonly panelBody = make("div", "mx-body");
  private readonly card = make("section", "mx-card");
  private readonly cardTitle = make("h2");
  private readonly cardBody = make("div", "mx-body");
  private readonly sections = new Map<string, HTMLElement>();

  constructor(viewer: MapelixViewer, container: HTMLElement, options: ViewerControlsOptions = {}) {
    this.viewer = viewer;
    this.t = { ...DEFAULT_CONTROL_TEXTS, ...options.texts };
    // A host whose policy forbids inline styles links `mapelix-viewer.css` with this marker.
    if (!styleInstalled && !document.querySelector("link[data-mapelix-styles]")) {
      const style = document.createElement("style");
      style.textContent = CONTROL_STYLE;
      document.head.append(style);
      styleInstalled = true;
    }
    const t = this.t;
    const root = (this.root = make("div", "mx-ui"));
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", t.region);
    if (options.theme) root.dataset.theme = options.theme;

    // Top: coordinates on the left, compass on the right.
    const top = make("div", "mx-top");
    const readout = make("p", "mx-readout mx-glass");
    readout.setAttribute("aria-live", "off");
    this.readoutNote.setAttribute("role", "status");
    readout.append(this.readoutPosition, this.readoutScale, this.readoutNote);
    this.compassIcon = document.createElementNS(SVG, "svg");
    this.compassIcon.setAttribute("viewBox", "0 0 24 24");
    this.compassIcon.setAttribute("aria-hidden", "true");
    for (const [cls, d] of [
      ["mx-north", "M12 3 15.5 12h-7Z"],
      ["mx-south", "M12 21 8.5 12h7Z"],
    ]) {
      const path = document.createElementNS(SVG, "path");
      path.setAttribute("class", cls!);
      path.setAttribute("d", d!);
      this.compassIcon.append(path);
    }
    this.compass = this.button(t.faceNorth, undefined, () => viewer.faceNorth());
    this.compass.classList.add("mx-compass");
    this.compass.append(this.compassIcon);
    top.append(readout, this.compass);

    // Middle: panels at the bottom left, the discovery card at the top right.
    const mid = make("div", "mx-mid");
    this.panel.id = `mx-panel-${Math.random().toString(36).slice(2)}`;
    this.panel.setAttribute("role", "dialog");
    this.panel.hidden = true;
    const head = make("div", "mx-head");
    head.append(
      make("span", "mx-grip"),
      this.panelTitle,
      this.button(t.close, ICONS.close, () => this.closePanel()),
    );
    this.panel.append(head, this.panelBody);
    this.swipeToClose(head);
    this.card.hidden = true;
    this.card.setAttribute("aria-label", t.discoveryCard);
    this.card.setAttribute("aria-live", "polite");
    const cardHead = make("div", "mx-head");
    cardHead.append(
      this.cardTitle,
      this.button(t.close, ICONS.close, () => this.closeCard()),
    );
    this.card.append(cardHead, this.cardBody);
    mid.append(this.card, this.panel);

    // Bottom left: settings, home, dimension (the thumb reaches the lowest first).
    const left = make("div", "mx-left");
    this.settingsButton = this.button(t.settings, ICONS.settings, (event) =>
      this.togglePanel("settings", event),
    );
    this.dimensionButton = this.button(t.dimensions, ICONS.layers, (event) =>
      this.togglePanel("dimensions", event),
    );
    for (const opener of [this.settingsButton, this.dimensionButton]) {
      opener.setAttribute("aria-expanded", "false");
      opener.setAttribute("aria-controls", this.panel.id);
    }
    const markerOptions = options.markers === undefined ? { editable: false } : options.markers;
    const editorTexts = { ...DEFAULT_MARKER_EDITOR_TEXTS, ...(markerOptions || {}).texts };
    const addButton =
      markerOptions && markerOptions.editable !== false
        ? this.button(editorTexts.add, ICONS.addMarker, () => undefined)
        : undefined;
    if (addButton) {
      addButton.dataset.part = "add-marker";
      left.append(addButton);
    }
    left.append(
      this.settingsButton,
      this.button(t.home, ICONS.home, () => void viewer.goHome()),
      this.dimensionButton,
    );

    // Bottom center: cave movement, 3D caves only.
    const center = make("div", "mx-center");
    this.caveGroup.setAttribute("role", "group");
    this.caveGroup.append(
      this.holdButton(t.descend, ICONS.down, -1),
      this.holdButton(t.ascend, ICONS.up, 1),
      this.button(t.recover, ICONS.recover, () => viewer.recoverCamera()),
    );
    center.append(this.caveGroup);

    // Bottom right: projection, 2D/3D, zoom.
    const right = make("div", "mx-right");
    this.projectionButton = this.button(t.isometric, ICONS.iso, () =>
      viewer.setProjection(viewer.projection === "isometric" ? "perspective" : "isometric"),
    );
    this.modeButton = this.button(t.showWorld, undefined, () =>
      viewer.mode === "3d" ? void viewer.showMap() : void viewer.showWorld(),
    );
    right.append(
      this.projectionButton,
      this.modeButton,
      this.button(t.zoomIn, ICONS.plus, () => viewer.zoomBy(2)),
      this.button(t.zoomOut, ICONS.minus, () => viewer.zoomBy(0.5)),
    );

    root.append(this.progress, top, mid, left, center, right);
    container.append(root);

    // Buttons pressed with a finger or the mouse hand the keys back to the view.
    root.addEventListener("click", this.release);
    document.addEventListener("keydown", this.onKey);
    // A press on the view closes the panel.
    container.addEventListener("pointerdown", this.onOutside, { capture: true });
    // The hint goes at the first gesture on the view.
    container.addEventListener("pointerdown", () => this.hideHint(), { once: true, passive: true });
    container.addEventListener("wheel", () => this.hideHint(), { once: true, passive: true });
    // The phone keyboard must not hide the form: the controls end above it.
    window.visualViewport?.addEventListener("resize", this.onViewport);
    window.visualViewport?.addEventListener("scroll", this.onViewport);
    this.panel.addEventListener("focusin", this.onPanelFocus);
    this.panel.addEventListener("focusout", this.onPanelBlur);
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(root);
    this.measure();

    this.hintShown = (options.hintMs ?? 9000) > 0;
    if (this.hintShown)
      this.hintTimer = window.setTimeout(() => this.hideHint(), options.hintMs ?? 9000);
    this.editor = markerOptions
      ? new MarkerEditor(
          viewer,
          this.surface(container, editorTexts.card),
          markerOptions,
          addButton,
        )
      : undefined;
    this.unsubscribe = viewer.subscribe((view, status, settings) => {
      this.state = { view, status, settings };
      this.render();
    });
  }

  /** What the marker editor may use: the bottom panel, the card, the readout note. */
  private surface(container: HTMLElement, cardLabel: string): EditorSurface {
    return {
      container,
      openSheet: (title, content, onClosed, focusFirst) => {
        this.closePanel();
        this.openPanel = "marker";
        this.panelOpener = undefined;
        this.sheetClosed = onClosed;
        this.hideHint();
        this.panelTitle.textContent = title;
        this.panel.setAttribute("aria-label", title);
        this.panelBody.replaceChildren(content);
        this.panel.hidden = false;
        this.render();
        if (focusFirst) content.querySelector<HTMLElement>("input, select, button")?.focus();
      },
      closeSheet: () => {
        if (this.openPanel === "marker") this.closePanel();
      },
      showCard: (title, content, onClosed) => {
        this.markerCard = { onClosed };
        this.card.setAttribute("aria-label", cardLabel);
        this.cardTitle.textContent = title;
        this.cardBody.replaceChildren(...content);
        if (this.state) this.render();
      },
      hideCard: () => {
        if (this.markerCard === undefined) return;
        this.markerCard = undefined;
        if (this.state) this.render();
      },
      setPrompt: (text) => {
        this.prompt = text;
        if (this.state) this.render();
      },
      isView: (target) => target instanceof Node && !this.root.contains(target),
      covers: (clientX, clientY) =>
        [this.panel, this.card].some((element) => {
          if (element.hidden) return false;
          const box = element.getBoundingClientRect();
          return (
            clientX >= box.left &&
            clientX <= box.right &&
            clientY >= box.top &&
            clientY <= box.bottom
          );
        }),
    };
  }

  dispose(): void {
    clearTimeout(this.hintTimer);
    cancelAnimationFrame(this.obstacleRequest);
    this.viewer.markers.setObstacles([]);
    this.unsubscribe();
    this.editor?.dispose();
    window.visualViewport?.removeEventListener("resize", this.onViewport);
    window.visualViewport?.removeEventListener("scroll", this.onViewport);
    this.resize.disconnect();
    document.removeEventListener("keydown", this.onKey);
    this.root.parentElement?.removeEventListener("pointerdown", this.onOutside, { capture: true });
    this.root.remove();
  }

  private button(
    label: string,
    path: string | undefined,
    action: (event: MouseEvent) => void,
  ): HTMLButtonElement {
    const button = make("button", "mx-btn");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.title = label;
    if (path) button.append(icon(path));
    button.addEventListener("click", action);
    return button;
  }

  /** A cave movement button: moves while held, or a short step from the keyboard. */
  private holdButton(label: string, path: string, direction: 1 | -1): HTMLButtonElement {
    const button = this.button(label, path, (event) => {
      if (event.detail !== 0) return;
      this.viewer.setVerticalMovement(direction);
      window.setTimeout(() => this.viewer.setVerticalMovement(0), 150);
    });
    const stop = (event?: Event) => {
      if (event instanceof PointerEvent && event.pointerId !== this.holding) return;
      this.holding = undefined;
      delete button.dataset.held;
      this.viewer.setVerticalMovement(0);
    };
    button.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      this.holding = event.pointerId;
      button.setPointerCapture(event.pointerId);
      button.dataset.held = "";
      this.viewer.setVerticalMovement(direction);
    });
    for (const type of ["pointerup", "pointercancel", "lostpointercapture"])
      button.addEventListener(type, stop);
    button.addEventListener("blur", () => stop());
    button.addEventListener("keydown", (event) => {
      if (event.code !== "Space" && event.code !== "Enter") return;
      event.preventDefault();
      this.viewer.setVerticalMovement(direction);
    });
    button.addEventListener("keyup", (event) => {
      if (event.code === "Space" || event.code === "Enter") this.viewer.setVerticalMovement(0);
    });
    return button;
  }

  /** Tells the marker layer where the controls are, so marker labels go around them. */
  private scheduleObstacles(): void {
    if (this.obstacleRequest !== 0) return;
    this.obstacleRequest = requestAnimationFrame(() => {
      this.obstacleRequest = 0;
      const container = this.root.parentElement;
      if (!container) return;
      const origin = container.getBoundingClientRect();
      const boxes = [];
      for (const element of this.root.querySelectorAll(
        ".mx-btn, .mx-readout, .mx-panel, .mx-card",
      )) {
        if (
          element.closest(".mx-panel, .mx-card") !== element &&
          element.closest(".mx-panel, .mx-card")
        )
          continue;
        if (!element.checkVisibility({ visibilityProperty: true })) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        boxes.push({
          left: box.left - origin.left,
          top: box.top - origin.top,
          right: box.right - origin.left,
          bottom: box.bottom - origin.top,
        });
      }
      const key = boxes.map((box) => `${box.left},${box.top},${box.right},${box.bottom}`).join(";");
      if (key === this.obstacleKey) return;
      this.obstacleKey = key;
      this.viewer.markers.setObstacles(boxes);
    });
  }

  private measure(): void {
    const { width, height } = this.root.getBoundingClientRect();
    this.root.toggleAttribute("data-narrow", width < NARROW);
    this.root.toggleAttribute("data-short", height < SHORT);
    if (this.state) this.render();
  }

  private readonly release = (event: MouseEvent): void => {
    if (event.detail === 0) return;
    // The path, not `target.closest`: a click may swap the icon it landed on.
    const button = event
      .composedPath()
      .find((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
    // Inside a panel or the card the focus stays; elsewhere it goes back to the view.
    if (button === undefined || this.panel.contains(button) || this.card.contains(button)) return;
    button.blur();
    if (this.openPanel === undefined) this.viewer.focus();
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.openPanel === undefined) return;
    event.preventDefault();
    this.closePanel(true);
  };

  /** Height of the phone keyboard over the controls, from the visual viewport. */
  private readonly onViewport = (): void => {
    const viewport = window.visualViewport;
    const container = this.root.parentElement;
    if (!viewport || !container) return;
    const bottom = container.getBoundingClientRect().bottom;
    const covered = Math.max(0, Math.round(bottom - (viewport.offsetTop + viewport.height)));
    const keyboard = covered > 60 ? covered : 0;
    if (keyboard === this.keyboard) return;
    this.keyboard = keyboard;
    this.root.style.setProperty("--mx-keyboard", `${keyboard}px`);
    this.scheduleObstacles();
    this.keepFocusedInView();
  };

  /** While typing in the panel on a phone, the bottom buttons make room for it. */
  private readonly onPanelFocus = (event: FocusEvent): void => {
    const target = event.target;
    const typing =
      (target instanceof HTMLInputElement &&
        !["checkbox", "radio", "range", "color", "button", "submit"].includes(target.type)) ||
      target instanceof HTMLTextAreaElement;
    // Kept until the focus leaves the panel: a tap on a checkbox must not move the panel under it.
    if (typing) this.root.toggleAttribute("data-typing", true);
    this.keepFocusedInView();
  };

  private readonly onPanelBlur = (event: FocusEvent): void => {
    if (event.relatedTarget instanceof Node && this.panel.contains(event.relatedTarget)) return;
    this.root.removeAttribute("data-typing");
  };

  private keepFocusedInView(): void {
    // After the keyboard and the layout have settled.
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && this.panel.contains(active))
        active.scrollIntoView({ block: "nearest" });
    }, 250);
  }

  private readonly onOutside = (event: PointerEvent): void => {
    if (this.openPanel === undefined || !(event.target instanceof Node)) return;
    // The marker form stays open while its marker is dragged or the map moved.
    if (this.openPanel === "marker") return;
    if (this.root.contains(event.target)) return;
    this.closePanel();
  };

  private hideHint(): void {
    if (!this.hintShown) return;
    this.hintShown = false;
    if (this.state) this.render();
  }

  private swipeToClose(handle: HTMLElement): void {
    let start: { id: number; y: number } | undefined;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target instanceof HTMLButtonElement) return;
      start = { id: event.pointerId, y: event.clientY };
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointerup", (event) => {
      if (start?.id === event.pointerId && event.clientY - start.y > 50) this.closePanel();
      start = undefined;
    });
    handle.addEventListener("pointercancel", () => (start = undefined));
  }

  private togglePanel(name: "settings" | "dimensions", event: MouseEvent): void {
    if (this.openPanel === name) return this.closePanel(event.detail === 0);
    this.openPanel = name;
    this.panelOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
    this.hideHint();
    this.panelBody.replaceChildren();
    this.sections.clear();
    this.lastGroups = "";
    if (name === "dimensions") this.buildDimensions();
    else this.buildSettings();
    this.panel.hidden = false;
    this.render();
    if (event.detail === 0)
      this.panel
        .querySelector<HTMLElement>(".mx-body button, .mx-body input, .mx-body select")
        ?.focus();
  }

  private closePanel(returnFocus = false): void {
    if (this.openPanel === undefined) return;
    const opener = this.panelOpener;
    const closed = this.openPanel === "marker" ? this.sheetClosed : undefined;
    this.sheetClosed = undefined;
    this.openPanel = undefined;
    this.root.removeAttribute("data-typing");
    this.panel.hidden = true;
    this.panelBody.replaceChildren();
    this.sections.clear();
    this.render();
    if (returnFocus && opener) opener.focus();
    else if (
      this.panel.contains(document.activeElement) ||
      document.activeElement === document.body ||
      (returnFocus && opener === undefined)
    )
      this.viewer.focus();
    closed?.();
  }

  private closeCard(): void {
    if (this.markerCard !== undefined) {
      const { onClosed } = this.markerCard;
      this.markerCard = undefined;
      this.render();
      onClosed();
      return;
    }
    this.cardDismissed = this.cardGroup;
    this.viewer.clearDiscoveryFocus();
  }

  private buildDimensions(): void {
    this.panelTitle.textContent = this.t.dimensions;
    this.panel.setAttribute("aria-label", this.t.dimensions);
    const menu = make("div", "mx-menu");
    menu.setAttribute("role", "group");
    menu.setAttribute("aria-label", this.t.dimensions);
    for (const name of this.viewer.dimensions) {
      const choice = make("button", "mx-text", this.t.dimensionName(name));
      choice.type = "button";
      choice.dataset.dimension = name;
      choice.addEventListener("click", () => {
        this.viewer.setDimension(name);
        this.closePanel();
      });
      menu.append(choice);
    }
    this.panelBody.append(menu);
  }

  private section(key: string, title: string): HTMLElement {
    const section = make("section");
    section.append(make("h3", undefined, title));
    this.sections.set(key, section);
    this.panelBody.append(section);
    return section;
  }

  private check(label: string, onChange: (checked: boolean) => void): HTMLInputElement {
    const wrapper = make("label", "mx-check");
    const input = make("input");
    input.type = "checkbox";
    input.addEventListener("change", () => onChange(input.checked));
    wrapper.append(input, document.createTextNode(label));
    input.dataset.wrapper = "";
    return Object.assign(input, { wrapperElement: wrapper });
  }

  private buildSettings(): void {
    const t = this.t,
      viewer = this.viewer;
    this.panel.setAttribute("aria-label", t.settings);

    // View: surface or caves, cave slice, Nether ceiling, exploration area.
    const view = this.section("view", t.view);
    const seg = make("div", "mx-seg");
    seg.setAttribute("role", "group");
    seg.setAttribute("aria-label", t.view);
    for (const [mode, label] of [
      ["surface", t.surface],
      ["caves", t.caves],
    ] as const) {
      const choice = make("button", "mx-text", label);
      choice.type = "button";
      choice.dataset.viewMode = mode;
      choice.addEventListener("click", () => viewer.setViewMode(mode));
      seg.append(choice);
    }
    const cavesNote = make("p", undefined, t.cavesNeedWorld);
    cavesNote.dataset.part = "caves-note";
    const caves = make("div");
    caves.dataset.part = "caves";
    const thickness = make("select");
    thickness.setAttribute("aria-label", t.sliceThickness);
    for (const value of CAVE_LIMITS.thicknesses) {
      const option = make("option", undefined, t.blocks(value));
      option.value = String(value);
      thickness.append(option);
    }
    thickness.addEventListener("change", () =>
      viewer.setCaveSlice(viewer.settings.caveMinY, Number(thickness.value)),
    );
    const depthLabel = make("label");
    const depth = make("input");
    depth.type = "range";
    depth.step = "16";
    depth.dataset.part = "depth";
    depth.addEventListener("input", () => {
      const minY = Number(depth.value);
      depthLabel.textContent = t.sliceRange(minY, minY + viewer.settings.caveThickness - 1);
    });
    depth.addEventListener("change", () => viewer.setCaveSlice(Number(depth.value)));
    depth.setAttribute("aria-label", t.sliceRange(0, 0));
    const depthField = make("div", "mx-field");
    depthField.append(depthLabel, depth);
    const thicknessField = make("label", "mx-field");
    thicknessField.append(document.createTextNode(t.sliceThickness), thickness);
    const auto = this.check(t.followDepth, (on) => viewer.setAutoDepth(on));
    auto.dataset.part = "auto-depth";
    const navigationNote = make("p");
    navigationNote.dataset.part = "navigation";
    navigationNote.setAttribute("role", "status");
    caves.append(thicknessField, depthField, wrapperOf(auto), navigationNote, this.areaControls());
    const ceiling = make("div", "mx-field");
    ceiling.dataset.part = "ceiling";
    const ceilingLabel = make("label");
    const ceilingInput = make("input");
    ceilingInput.type = "range";
    ceilingInput.min = "16";
    ceilingInput.max = "128";
    ceilingInput.step = "16";
    ceilingInput.addEventListener("input", () => {
      ceilingLabel.textContent = t.ceiling(Number(ceilingInput.value));
    });
    ceilingInput.addEventListener("change", () =>
      viewer.setNetherCeiling(Number(ceilingInput.value)),
    );
    ceiling.append(ceilingLabel, ceilingInput);
    // Block textures near the camera, when the server has them.
    const textures = this.check(t.textures, (on) => viewer.setTextures(on ? "on" : "off"));
    textures.dataset.part = "textures";
    const leaves = this.check(t.detailedLeaves, (on) => viewer.setLeaves(on ? "detailed" : "fast"));
    leaves.dataset.part = "leaves";
    const texturesNote = make("p", undefined);
    texturesNote.dataset.part = "textures-note";
    view.append(
      seg,
      cavesNote,
      ceiling,
      caves,
      wrapperOf(textures),
      wrapperOf(leaves),
      texturesNote,
    );

    // Sky: clouds, rain, thunderstorm, time of day (Overworld surface).
    const sky = this.section("sky", t.atmosphere);
    const skyNote = make("p", undefined, t.atmosphereOnly);
    skyNote.dataset.part = "sky-note";
    const clouds = this.check(t.clouds, (on) => viewer.setClouds(on));
    clouds.dataset.part = "clouds";
    const rain = this.check(t.rain, (on) => viewer.setWeather(on ? "rain" : "clear"));
    rain.dataset.part = "rain";
    const storm = this.check(t.thunderstorm, (on) =>
      viewer.setWeather(on ? "thunderstorm" : "rain"),
    );
    storm.dataset.part = "storm";
    const row = make("div", "mx-row");
    row.append(wrapperOf(clouds), wrapperOf(rain), wrapperOf(storm));
    const time = make("div", "mx-field");
    const timeLabel = make("label");
    timeLabel.dataset.part = "time-label";
    const timeInput = make("input");
    timeInput.type = "range";
    timeInput.min = "0";
    timeInput.max = "24";
    timeInput.step = "0.25";
    timeInput.dataset.part = "time";
    timeInput.setAttribute("aria-label", t.timeOfDay);
    timeInput.addEventListener("input", () => viewer.setTimeOfDay(Number(timeInput.value)));
    time.append(timeLabel, timeInput);
    sky.append(skyNote, row, time);

    // Discoveries: filters and the list of what was found.
    const found = this.section("discoveries", t.discoveries);
    const show = this.check(t.showDiscoveries, (on) => viewer.setDiscoveryFilters({ enabled: on }));
    show.dataset.part = "show";
    const note = make("p");
    note.dataset.part = "discovery-note";
    const filters = make("div");
    filters.dataset.part = "filters";
    const categories = make("div", "mx-row");
    for (const category of DISCOVERY_CATEGORIES) {
      const box = this.check(t.categories[category], (on) => {
        const current = viewer.settings.discoveries.categories;
        viewer.setDiscoveryFilters({
          categories: on ? [...current, category] : current.filter((entry) => entry !== category),
        });
      });
      box.dataset.category = category;
      categories.append(wrapperOf(box));
    }
    const ores = make("fieldset");
    ores.dataset.part = "ores";
    ores.style.border = "0";
    ores.style.padding = "0";
    ores.style.margin = "4px 0";
    const legend = make("legend", undefined, t.oreTypes);
    const oreRow = make("div", "mx-row");
    for (const kind of DISCOVERY_KINDS.filter((entry) => entry.category === "ores")) {
      const box = this.check(t.kind(kind.id, kind.label), (on) => {
        const current = viewer.settings.discoveries.ores;
        viewer.setDiscoveryFilters({
          ores: on ? [...current, kind.id] : current.filter((entry) => entry !== kind.id),
        });
      });
      box.dataset.ore = kind.id;
      oreRow.append(wrapperOf(box));
    }
    ores.append(legend, oreRow);
    const exposure = make("select");
    exposure.dataset.part = "exposure";
    for (const value of ["all", "exposed", "buried"] as const) {
      const option = make("option", undefined, t.exposures[value]);
      option.value = value;
      exposure.append(option);
    }
    exposure.addEventListener("change", () =>
      viewer.setDiscoveryFilters({ exposure: exposure.value as "all" | "exposed" | "buried" }),
    );
    const exposureField = make("label", "mx-field");
    exposureField.append(document.createTextNode(t.exposure), exposure);
    const heights = this.check(t.allHeights, (on) =>
      viewer.setDiscoveryFilters({ allHeights: on }),
    );
    heights.dataset.part = "heights";
    const status = make("p");
    status.dataset.part = "search";
    status.setAttribute("role", "status");
    const limited = make("p", undefined, t.limited);
    limited.dataset.part = "limited";
    const uncertain = make("p", undefined, t.uncertain);
    uncertain.dataset.part = "uncertain";
    const error = make("p");
    error.dataset.part = "discovery-error";
    error.setAttribute("role", "alert");
    const list = make("ul", "mx-list");
    list.dataset.part = "list";
    list.setAttribute("aria-label", t.found);
    filters.append(
      categories,
      ores,
      exposureField,
      wrapperOf(heights),
      status,
      limited,
      uncertain,
      error,
      list,
    );
    found.append(wrapperOf(show), note, filters);

    // Go to coordinates.
    const go = this.section("goto", t.goTo);
    const form = make("form", "mx-grid2");
    const fields = (["x", "z"] as const).map((axis) => {
      const field = make("label", "mx-field");
      const input = make("input");
      input.type = "number";
      input.step = "1";
      input.required = true;
      input.name = axis;
      input.inputMode = "numeric";
      field.append(document.createTextNode(axis.toUpperCase()), input);
      form.append(field);
      return input;
    });
    const submit = make("button", "mx-text mx-solid", t.go);
    submit.type = "submit";
    submit.style.gridColumn = "1 / -1";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      viewer.goTo(Number(fields[0]!.value), Number(fields[1]!.value));
      if (this.root.hasAttribute("data-narrow")) this.closePanel();
    });
    const center = this.viewer.view;
    fields[0]!.value = String(Math.round(center.x));
    fields[1]!.value = String(Math.round(center.z));
    go.append(form);
  }

  private areaControls(): HTMLElement {
    const t = this.t,
      viewer = this.viewer;
    const area = make("div");
    area.dataset.part = "area";
    area.append(make("h3", undefined, t.area), make("p", undefined, t.areaHelp));
    const buttons = make("div", "mx-row");
    const select = make("button", "mx-text mx-solid", t.selectAround);
    select.type = "button";
    select.addEventListener("click", () => viewer.selectAroundView());
    const clear = make("button", "mx-text", t.clearArea);
    clear.type = "button";
    clear.dataset.part = "clear-area";
    clear.addEventListener("click", () => viewer.setSelection(undefined));
    buttons.append(select, clear);
    const bounds = make("form", "mx-grid2");
    bounds.dataset.part = "bounds";
    const inputs = (["minX", "maxX", "minZ", "maxZ"] as const).map((name) => {
      const field = make("label", "mx-field");
      const input = make("input");
      input.type = "number";
      input.step = "1";
      input.required = true;
      input.name = name;
      field.append(document.createTextNode(t.areaBounds[name]), input);
      bounds.append(field);
      return input;
    });
    const apply = make("button", "mx-text mx-solid", t.applyArea);
    apply.type = "submit";
    apply.style.gridColumn = "1 / -1";
    const error = make("p");
    error.setAttribute("role", "alert");
    bounds.append(apply, error);
    bounds.addEventListener("submit", (event) => {
      event.preventDefault();
      const [minX, maxX, minZ, maxZ] = inputs.map((input) => Number(input.value));
      try {
        viewer.setSelection({ minX: minX!, maxX: maxX!, minZ: minZ!, maxZ: maxZ! });
        error.textContent = "";
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
      }
    });
    const tool = make("select");
    tool.dataset.part = "tool";
    for (const value of ["off", "move", "resize"] as const) {
      const option = make("option", undefined, t.areaTools[value]);
      option.value = value;
      tool.append(option);
    }
    tool.addEventListener("change", () =>
      viewer.setSelectionTool(tool.value as "off" | "move" | "resize"),
    );
    const toolField = make("label", "mx-field");
    toolField.dataset.part = "tool-field";
    toolField.append(document.createTextNode(t.areaTool), tool);
    area.append(buttons, bounds, toolField);
    return area;
  }

  private part<T extends HTMLElement>(name: string): T | undefined {
    return this.panelBody.querySelector<T>(`[data-part="${name}"]`) ?? undefined;
  }

  private render(): void {
    this.scheduleObstacles();
    const { view, status, settings } = this.state;
    const t = this.t;
    const is3d = view.mode === "3d";
    this.root.dataset.mode = view.mode;
    this.root.toggleAttribute("data-editing", this.openPanel === "marker");

    // Readout: block under the pointer, else the view center; then scale and status.
    const at = status.pointed ?? { x: Math.floor(view.x), z: Math.floor(view.z) };
    this.readoutPosition.textContent = t.position(at.x, at.z, at.y);
    this.readoutScale.textContent = t.scale(view.pixelsPerBlock);
    const note = status.failure
      ? status.failure
      : this.prompt !== undefined
        ? this.prompt
        : status.changing
          ? t.changing
          : status.emptyCaves
            ? t.emptyCaves
            : this.hintShown
              ? t.hint
              : status.loading > 0
                ? t.loading(status.loading)
                : "";
    this.readoutNote.textContent = note;
    this.readoutNote.hidden = note === "";
    this.readoutNote.toggleAttribute("data-alert", status.failure !== undefined);
    this.progress.hidden = !(status.changing || status.loading > 0);

    // Controls keep their place; those without meaning now are hidden.
    setOff(this.compass, !is3d);
    this.compassIcon.style.transform = `rotate(${-view.heading}rad)`;
    setOff(this.projectionButton, !is3d);
    const iso = view.projection === "isometric";
    this.projectionButton.setAttribute("aria-pressed", String(iso));
    this.projectionButton.title = iso ? t.toPerspective : t.toIsometric;
    // Replaced only on change: a click must not land on an icon removed under it.
    if (this.projectionButton.dataset.icon !== view.projection) {
      this.projectionButton.dataset.icon = view.projection;
      this.projectionButton.firstElementChild?.replaceWith(icon(iso ? ICONS.iso : ICONS.persp));
    }
    this.modeButton.hidden = !status.available;
    this.modeButton.textContent = is3d ? "2D" : "3D";
    this.modeButton.setAttribute("aria-label", is3d ? t.showMap : t.showWorld);
    this.modeButton.title = is3d ? t.showMap : t.showWorld;
    const caves = is3d && status.context?.mode === "caves";
    setOff(this.caveGroup, !caves);
    this.caveGroup.setAttribute("aria-label", t.caves);
    this.dimensionButton.hidden = this.viewer.dimensions.length < 2;
    for (const [opener, name] of [
      [this.settingsButton, "settings"],
      [this.dimensionButton, "dimensions"],
    ] as const)
      opener.setAttribute("aria-expanded", String(this.openPanel === name));

    // Discovery card; on a narrow screen it gives way to an open panel.
    const group = status.focusedDiscovery;
    if (group !== this.cardGroup) {
      this.cardGroup = group;
      if (group !== undefined) {
        // A discovery takes the card from a marker.
        if (this.markerCard !== undefined) {
          const { onClosed } = this.markerCard;
          this.markerCard = undefined;
          onClosed();
        }
        this.card.setAttribute("aria-label", t.discoveryCard);
        this.cardDismissed = undefined;
        if (this.openPanel !== undefined && this.root.hasAttribute("data-narrow"))
          this.closePanel();
        const text = this.viewer.describeDiscovery(group);
        this.cardTitle.textContent = text.title;
        this.cardBody.replaceChildren(...text.lines.map((line) => make("p", undefined, line)));
      }
    }
    this.card.hidden =
      (this.markerCard === undefined && (group === undefined || group === this.cardDismissed)) ||
      (this.openPanel !== undefined && this.root.hasAttribute("data-narrow"));

    if (this.openPanel === "settings") this.renderSettings(view, status, settings);
    if (this.openPanel === "dimensions")
      for (const choice of this.panelBody.querySelectorAll<HTMLButtonElement>("[data-dimension]"))
        choice.setAttribute("aria-pressed", String(choice.dataset.dimension === view.dimension));
  }

  private renderSettings(view: ViewState, status: WorldStatus, settings: WorldSettings): void {
    const t = this.t;
    this.panelTitle.textContent = t.world(status.name);
    const context = status.context;
    const dimension = context?.dimension ?? safeDimension(view.dimension);
    const caves = settings.viewMode === "caves";
    for (const choice of this.panelBody.querySelectorAll<HTMLButtonElement>("[data-view-mode]")) {
      choice.setAttribute("aria-pressed", String(choice.dataset.viewMode === settings.viewMode));
      choice.disabled = !status.available || status.changing || dimension === undefined;
    }
    show(this.part("caves-note"), !status.available);
    show(this.part("caves"), caves && status.available && dimension !== undefined);
    show(this.part("ceiling"), !caves && dimension === "nether" && status.available);
    if (dimension !== undefined) {
      const config = DIMENSIONS[dimension];
      const depth = this.part<HTMLInputElement>("depth");
      if (depth && document.activeElement !== depth) {
        depth.min = String(config.minY);
        depth.max = String(config.maxY - settings.caveThickness);
        depth.value = String(settings.caveMinY);
        const label = depth.previousElementSibling;
        if (label)
          label.textContent = t.sliceRange(
            settings.caveMinY,
            settings.caveMinY + settings.caveThickness - 1,
          );
        depth.setAttribute(
          "aria-label",
          t.sliceRange(settings.caveMinY, settings.caveMinY + settings.caveThickness - 1),
        );
      }
      const thickness = this.panelBody.querySelector<HTMLSelectElement>("[data-part=caves] select");
      if (thickness) thickness.value = String(settings.caveThickness);
      const ceiling = this.part("ceiling");
      const ceilingInput = ceiling?.querySelector("input");
      if (ceilingInput && document.activeElement !== ceilingInput) {
        ceilingInput.value = String(settings.netherCeilingY);
        ceiling!.querySelector("label")!.textContent = t.ceiling(settings.netherCeilingY);
        ceilingInput.setAttribute("aria-label", t.ceiling(settings.netherCeilingY));
      }
    }
    const auto = this.part<HTMLInputElement>("auto-depth");
    if (auto) {
      auto.checked = settings.autoDepth;
      auto.disabled = status.navigation !== undefined && !status.navigation.available;
    }
    const navigation = this.part("navigation");
    if (navigation)
      navigation.textContent =
        status.navigation?.error ?? (status.navigation?.loading ? t.openingDepth : t.caveKeys);
    const hasArea = settings.selection !== undefined;
    show(this.part("clear-area"), hasArea);
    show(this.part("bounds"), hasArea);
    show(this.part("tool-field"), hasArea);
    const bounds = this.part<HTMLFormElement>("bounds");
    if (bounds && settings.selection && !bounds.contains(document.activeElement))
      for (const name of ["minX", "maxX", "minZ", "maxZ"] as const)
        (bounds.elements.namedItem(name) as HTMLInputElement).value = String(
          settings.selection[name],
        );
    const tool = this.part<HTMLSelectElement>("tool");
    if (tool) tool.value = settings.selectionTool;

    // Block textures.
    const textures = this.part<HTMLInputElement>("textures");
    if (textures) {
      textures.checked = settings.textures === "on";
      textures.disabled = !status.available || status.textures === "unavailable";
    }
    const leaves = this.part<HTMLInputElement>("leaves");
    if (leaves) {
      leaves.checked = settings.leaves === "detailed";
      // Only textured leaves have a detailed look.
      show(wrapperOf(leaves), settings.textures === "on");
    }
    const texturesNote = this.part("textures-note");
    if (texturesNote) {
      const note =
        status.textures === "unavailable"
          ? this.t.texturesUnavailable
          : status.textures === "failed"
            ? this.t.texturesFailed
            : "";
      texturesNote.textContent = note;
      show(texturesNote, note !== "");
    }

    // Sky.
    const sky =
      status.available &&
      (context === undefined ? dimension === "overworld" : status.atmosphere) &&
      !caves;
    show(this.part("sky-note"), !sky);
    const clouds = this.part<HTMLInputElement>("clouds"),
      rain = this.part<HTMLInputElement>("rain"),
      storm = this.part<HTMLInputElement>("storm"),
      time = this.part<HTMLInputElement>("time");
    for (const input of [clouds, rain, storm, time]) if (input) input.disabled = !sky;
    if (clouds) clouds.checked = settings.clouds;
    if (rain) rain.checked = settings.weather !== "clear";
    if (storm) {
      storm.checked = settings.weather === "thunderstorm";
      storm.disabled = !sky || settings.weather === "clear";
    }
    if (time && document.activeElement !== time) time.value = String(settings.hour);
    const timeLabel = this.part("time-label");
    if (timeLabel) timeLabel.textContent = `${t.timeOfDay} · ${t.time(settings.hour)}`;

    // Discoveries.
    const stats = status.discoveries;
    const filters = settings.discoveries;
    const show3d = this.part<HTMLInputElement>("show");
    if (show3d) {
      show3d.checked = filters.enabled;
      show3d.disabled = !status.available || (stats !== undefined && !stats.available);
    }
    const note = this.part("discovery-note");
    if (note) {
      note.textContent = !status.available
        ? t.cavesNeedWorld
        : stats === undefined
          ? t.discoveriesIn3D
          : !stats.available
            ? t.discoveriesUnavailable
            : "";
      note.hidden = note.textContent === "";
    }
    show(this.part("filters"), filters.enabled && status.available);
    for (const box of this.panelBody.querySelectorAll<HTMLInputElement>("[data-category]"))
      box.checked = filters.categories.includes(box.dataset.category as never);
    show(this.part("ores"), filters.categories.includes("ores"));
    for (const box of this.panelBody.querySelectorAll<HTMLInputElement>("[data-ore]"))
      box.checked = filters.ores.includes(box.dataset.ore!);
    const exposure = this.part<HTMLSelectElement>("exposure");
    if (exposure) exposure.value = filters.exposure;
    const heights = this.part<HTMLInputElement>("heights");
    if (heights) heights.checked = filters.allHeights;
    const search = this.part("search");
    if (search)
      search.textContent =
        stats === undefined
          ? ""
          : `${stats.remaining ? t.searching(stats.remaining) : stats.grouping ? t.grouping : ""} ${t.searchDone(stats.matchingBlocks, stats.groups.length)}`.trim();
    show(this.part("limited"), stats?.limited === true);
    show(this.part("uncertain"), stats?.groups.some((group) => group.unknown > 0) === true);
    const error = this.part("discovery-error");
    if (error) {
      error.textContent = stats?.error ?? "";
      error.hidden = !stats?.error;
    }
    const list = this.part("list");
    const groups = stats?.groups.slice(0, 40) ?? [];
    const key = groups.map((group) => `${group.id}:${group.count}`).join(",");
    if (list && key !== this.lastGroups) {
      this.lastGroups = key;
      list.replaceChildren(
        ...groups.map((group) => {
          const item = make("li");
          const kind = DISCOVERY_KINDS[group.kind];
          const name = t.kind(kind?.id ?? "", kind?.label ?? "");
          const button = make("button", "mx-text");
          button.type = "button";
          button.setAttribute("aria-label", t.explore(name, group.x, group.y, group.z));
          button.append(
            make("span", undefined, t.groupLabel(name, group.count)),
            make("small", undefined, t.position(group.x, group.z, group.y)),
          );
          button.addEventListener("click", () => {
            if (this.root.hasAttribute("data-narrow")) this.closePanel();
            void this.viewer.focusDiscovery(group);
          });
          item.append(button);
          return item;
        }),
      );
    }
  }
}

function wrapperOf(input: HTMLInputElement): HTMLElement {
  return (input as HTMLInputElement & { wrapperElement: HTMLElement }).wrapperElement;
}

function setOff(element: HTMLElement, off: boolean): void {
  element.classList.toggle("mx-off", off);
  element.inert = off;
  element.setAttribute("aria-hidden", String(off));
}

function show(element: HTMLElement | undefined, visible: boolean): void {
  if (element) element.hidden = !visible;
}

function safeDimension(name: string) {
  try {
    return parseDimension(name);
  } catch {
    return undefined;
  }
}

/** Adds the controls to `container` (usually the viewer's element). */
export function createViewerControls(
  viewer: MapelixViewer,
  container: HTMLElement,
  options?: ViewerControlsOptions,
): ViewerControls {
  return new ViewerControls(viewer, container, options);
}
