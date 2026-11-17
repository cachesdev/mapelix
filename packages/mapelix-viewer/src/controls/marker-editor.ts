import type { Marker, MarkerInput } from "../markers/marker-layer.js";
import type { MapelixViewer } from "../viewer/mapelix-viewer.js";
import { DEFAULT_MARKER_EDITOR_TEXTS, type MarkerEditorTexts } from "./marker-editor-texts.js";

/** A host field shown in the marker form, such as a "public" checkbox. */
export interface MarkerField {
  /** Key of the value in `MarkerDraft.fields`. */
  readonly key: string;
  readonly label: string;
  readonly type: "checkbox" | "text" | "number" | "select";
  /** Choices of a `select`. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** Value of a new marker. */
  readonly default?: string | number | boolean;
}

export type MarkerFieldValue = string | number | boolean | undefined;

/** What the form holds; the host saves it and answers with the marker to show. */
export interface MarkerDraft {
  readonly id: string;
  readonly x: number;
  readonly y?: number;
  readonly z: number;
  readonly dimension: string;
  readonly label?: string;
  readonly icon?: string;
  readonly color?: string;
  readonly group?: string;
  readonly fields: Readonly<Record<string, MarkerFieldValue>>;
}

type Saved = MarkerInput | void | undefined;

/**
 * Options of the default marker editor. Mapelix keeps nothing: the host saves in `onCreate`,
 * `onUpdate` and `onDelete`, and refuses by throwing (the error message is shown). Without a
 * handler, the change only applies to the markers on screen.
 */
export interface MarkerEditorOptions {
  /** False shows marker cards only, for a public read-only map. Default true. */
  readonly editable?: boolean;
  /** Whether a marker may be changed (default: every marker when editable). */
  readonly canEdit?: (marker: Marker) => boolean;
  /** Whether a marker may be deleted (default: `canEdit`). */
  readonly canDelete?: (marker: Marker) => boolean;
  /** Extra form fields, drawn generically. */
  readonly fields?: readonly MarkerField[];
  /** Values of the extra fields for an existing marker, from the host's own data. */
  readonly fieldValues?: (marker: Marker) => Readonly<Record<string, MarkerFieldValue>>;
  /** Extra lines of the marker card. */
  readonly describe?: (marker: Marker) => readonly string[];
  /** Host checks before saving; a message refuses the draft. */
  readonly validate?: (draft: MarkerDraft, before: Marker | undefined) => string | undefined;
  readonly onCreate?: (draft: MarkerDraft) => Saved | Promise<Saved>;
  readonly onUpdate?: (draft: MarkerDraft, before: Marker) => Saved | Promise<Saved>;
  readonly onDelete?: (marker: Marker) => void | Promise<void>;
  /** Id of a new marker (default: random). */
  readonly newId?: () => string;
  /** Quick icon and color choices. */
  readonly icons?: readonly string[];
  readonly colors?: readonly string[];
  /** Group suggestions, besides the groups already on the map. */
  readonly groups?: readonly string[];
  readonly texts?: Partial<MarkerEditorTexts>;
}

/** What the controls lend the editor: their panel, a card slot and the readout. */
export interface EditorSurface {
  readonly container: HTMLElement;
  /** Opens the bottom panel with this content; `onClosed` runs when it closes for any reason. */
  openSheet(title: string, content: HTMLElement, onClosed: () => void, focusFirst: boolean): void;
  closeSheet(): void;
  showCard(title: string, content: readonly HTMLElement[], onClosed: () => void): void;
  hideCard(): void;
  setPrompt(text: string | undefined): void;
  /** A press on the map or the 3D view, not on a control. */
  isView(target: EventTarget | null): boolean;
  /** Whether the panel or the card is over this screen point. */
  covers(clientX: number, clientY: number): boolean;
}

const LONG_PRESS_MS = 500;
const SLOP = 10;
const TAP_MS = 450;
const LIMIT = 30_000_000;
const DEFAULT_ICONS = ["★", "⌂", "◎", "▲", "⚑", "⛏", "✚", "●"];
const DEFAULT_COLORS = [
  "#e8604c",
  "#e0a526",
  "#3f8f5a",
  "#2f86c4",
  "#8a4fd6",
  "#b9773f",
  "#6b7280",
  "#d6457e",
];

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

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `marker-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return fallback;
}

function hexColor(value: string | undefined): string {
  return value !== undefined && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : "#e8604c";
}

interface Form {
  readonly id: string;
  readonly before: Marker | undefined;
  readonly dimension: string;
  readonly base: Pick<MarkerInput, "image" | "priority" | "data">;
  readonly root: HTMLElement;
  readonly inputs: {
    readonly label: HTMLInputElement;
    readonly icon: HTMLInputElement;
    readonly color: HTMLInputElement;
    readonly group: HTMLInputElement;
    readonly x: HTMLInputElement;
    readonly y: HTMLInputElement;
    readonly z: HTMLInputElement;
  };
  readonly fields: Map<string, { field: MarkerField; input: HTMLInputElement | HTMLSelectElement }>;
  readonly error: HTMLParagraphElement;
  readonly save: HTMLButtonElement;
  saving: boolean;
  /** The sheet closes on success: no revert then. */
  done: boolean;
}

/**
 * The default marker editor of the controls: add with a button then a tap, or a long press on
 * the view; tap a marker for its card (edit, delete); drag the marker being edited. Only calls
 * `viewer.markers` and the host handlers, so a host can replace it.
 */
export class MarkerEditor {
  private readonly viewer: MapelixViewer;
  private readonly surface: EditorSurface;
  private readonly options: MarkerEditorOptions;
  private readonly t: MarkerEditorTexts;
  readonly addButton: HTMLButtonElement | undefined;
  private placing = false;
  private form: Form | undefined;
  private cardMarker: Marker | undefined;
  /** Where the card's marker was tapped, to keep it in view while it is edited. */
  private cardPoint: { x: number; y: number } | undefined;
  private readonly pointers = new Set<number>();
  private press:
    | { id: number; x: number; y: number; time: number; moved: boolean; fired: boolean }
    | undefined;
  private longTimer = 0;
  private drag: { pointer: number; frame: number; x: number; y: number } | undefined;
  private readonly unsubscribe: () => void;

  constructor(
    viewer: MapelixViewer,
    surface: EditorSurface,
    options: MarkerEditorOptions,
    addButton: HTMLButtonElement | undefined,
  ) {
    this.viewer = viewer;
    this.surface = surface;
    this.options = options;
    this.t = { ...DEFAULT_MARKER_EDITOR_TEXTS, ...options.texts };
    this.addButton = this.editable ? addButton : undefined;
    if (this.addButton) {
      this.addButton.setAttribute("aria-pressed", "false");
      this.addButton.addEventListener("click", () => this.togglePlacing());
    }
    this.unsubscribe = viewer.markers.onClick((event) => {
      // While a marker is edited it stays the selected one.
      if (this.form !== undefined) this.viewer.markers.select(this.form.id);
      else if (!this.placing) {
        this.cardPoint = { x: event.clientX, y: event.clientY };
        this.showCard(event.marker);
      }
    });
    const container = surface.container;
    container.addEventListener("pointerdown", this.onPointerDown, { capture: true });
    container.addEventListener("pointermove", this.onPointerMove, { capture: true });
    container.addEventListener("pointerup", this.onPointerUp, { capture: true });
    container.addEventListener("pointercancel", this.onPointerCancel, { capture: true });
    container.addEventListener("wheel", this.cancelLongPress, { passive: true });
    document.addEventListener("keydown", this.onKey);
  }

  get editable(): boolean {
    return this.options.editable !== false;
  }

  dispose(): void {
    this.unsubscribe();
    clearTimeout(this.longTimer);
    const container = this.surface.container;
    container.removeEventListener("pointerdown", this.onPointerDown, { capture: true });
    container.removeEventListener("pointermove", this.onPointerMove, { capture: true });
    container.removeEventListener("pointerup", this.onPointerUp, { capture: true });
    container.removeEventListener("pointercancel", this.onPointerCancel, { capture: true });
    container.removeEventListener("wheel", this.cancelLongPress);
    document.removeEventListener("keydown", this.onKey);
  }

  // ── Adding ────────────────────────────────────────────────────────────────

  private togglePlacing(): void {
    this.setPlacing(!this.placing);
  }

  private setPlacing(placing: boolean): void {
    if (placing && !this.editable) return;
    this.placing = placing;
    this.addButton?.setAttribute("aria-pressed", String(placing));
    this.surface.setPrompt(placing ? this.t.placePrompt : undefined);
    if (placing) {
      this.surface.closeSheet();
      this.hideCard();
    }
  }

  private createAt(clientX: number, clientY: number): void {
    const block = this.viewer.pickBlock(clientX, clientY);
    if (block === undefined) return;
    this.setPlacing(false);
    this.hideCard();
    const fields: Record<string, MarkerFieldValue> = {};
    for (const field of this.options.fields ?? []) fields[field.key] = field.default;
    this.openForm(
      undefined,
      {
        id: this.options.newId?.() ?? randomId(),
        x: block.x,
        z: block.z,
        dimension: this.viewer.dimension,
        fields,
      },
      false,
    );
    this.reveal(block.x, block.z, { x: clientX, y: clientY });
  }

  /** Brings the marker being edited out from under the form, so it can be seen and dragged. */
  private reveal(x: number, z: number, point: { x: number; y: number } | undefined): void {
    requestAnimationFrame(() => {
      if (point === undefined || this.surface.covers(point.x, point.y))
        this.viewer.goTo(x + 0.5, z + 0.5);
    });
  }

  // ── Card ──────────────────────────────────────────────────────────────────

  private canEdit(marker: Marker): boolean {
    return this.editable && (this.options.canEdit?.(marker) ?? true);
  }

  private canDelete(marker: Marker): boolean {
    return this.editable && (this.options.canDelete?.(marker) ?? this.canEdit(marker));
  }

  private showCard(marker: Marker, confirming = false, error?: string): void {
    const t = this.t;
    this.cardMarker = marker;
    this.viewer.clearDiscoveryFocus();
    this.viewer.markers.select(marker.id);
    const content: HTMLElement[] = [
      make("p", undefined, t.coordinates(marker.x, marker.z, marker.y)),
    ];
    if (marker.group !== undefined) content.push(make("p", undefined, t.groupLine(marker.group)));
    for (const line of this.options.describe?.(marker) ?? [])
      content.push(make("p", undefined, line));
    const alert = make("p", "mx-error", error ?? "");
    alert.setAttribute("role", "alert");
    alert.hidden = error === undefined;
    content.push(alert);
    const actions = make("div", "mx-actions");
    if (confirming) {
      content.push(make("p", "mx-confirm", t.confirmDelete(marker.label ?? t.untitled)));
      const remove = this.textButton(t.delete, "mx-danger", () => void this.remove(marker, remove));
      remove.dataset.part = "confirm-delete";
      actions.append(
        this.textButton(t.cancel, undefined, () => this.showCard(marker)),
        remove,
      );
      content.push(actions);
    } else if (this.canEdit(marker) || this.canDelete(marker)) {
      if (this.canDelete(marker))
        actions.append(this.textButton(t.delete, "mx-danger", () => this.showCard(marker, true)));
      if (this.canEdit(marker))
        actions.append(
          this.textButton(t.edit, "mx-solid", (event) => {
            const point = this.cardPoint;
            this.hideCard();
            this.openForm(marker, this.draftOf(marker), event.detail === 0);
            this.reveal(marker.x, marker.z, point);
          }),
        );
      content.push(actions);
    } else if (this.editable) content.push(make("p", undefined, t.readOnly));
    this.surface.showCard(marker.label ?? t.untitled, content, () => {
      if (this.cardMarker?.id === marker.id) {
        this.cardMarker = undefined;
        this.viewer.markers.select(undefined);
      }
    });
    if (confirming) actions.querySelector<HTMLButtonElement>("[data-part=confirm-delete]")?.focus();
  }

  private hideCard(): void {
    if (this.cardMarker === undefined) return;
    this.cardMarker = undefined;
    this.surface.hideCard();
  }

  private async remove(marker: Marker, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      await this.options.onDelete?.(marker);
    } catch (error) {
      this.showCard(marker, false, errorText(error, this.t.deleteFailed));
      return;
    }
    this.viewer.markers.remove(marker.id);
    this.hideCard();
    this.viewer.focus();
  }

  // ── Form ──────────────────────────────────────────────────────────────────

  private draftOf(marker: Marker): MarkerDraft {
    return {
      id: marker.id,
      x: marker.x,
      z: marker.z,
      dimension: marker.dimension,
      ...(marker.y === undefined ? {} : { y: marker.y }),
      ...(marker.label === undefined ? {} : { label: marker.label }),
      ...(marker.icon === undefined ? {} : { icon: marker.icon }),
      ...(marker.color === undefined ? {} : { color: marker.color }),
      ...(marker.group === undefined ? {} : { group: marker.group }),
      fields: {
        ...this.options.fields?.reduce<Record<string, MarkerFieldValue>>(
          (values, field) => ({ ...values, [field.key]: field.default }),
          {},
        ),
        ...this.options.fieldValues?.(marker),
      },
    };
  }

  private openForm(before: Marker | undefined, draft: MarkerDraft, focusFirst: boolean): void {
    const t = this.t;
    const root = make("form", "mx-form");
    root.noValidate = true;
    const field = (label: string, input: HTMLElement, wide = true) => {
      const wrapper = make("label", wide ? "mx-field" : "mx-field mx-narrow");
      wrapper.append(make("span", undefined, label), input);
      return wrapper;
    };
    const text = (value: string | undefined, max: number, name: string) => {
      const input = make("input");
      input.type = "text";
      input.name = name;
      input.maxLength = max;
      input.autocomplete = "off";
      input.value = value ?? "";
      return input;
    };
    const number = (value: number | undefined, name: string) => {
      const input = make("input");
      input.type = "text";
      input.inputMode = "numeric";
      input.name = name;
      input.autocomplete = "off";
      input.value = value === undefined ? "" : String(value);
      return input;
    };
    const inputs = {
      label: text(draft.label, 120, "label"),
      icon: text(draft.icon, 8, "icon"),
      color: make("input"),
      group: text(draft.group, 60, "group"),
      x: number(draft.x, "x"),
      y: number(draft.y, "y"),
      z: number(draft.z, "z"),
    };
    inputs.color.type = "color";
    inputs.color.name = "color";
    inputs.color.value = hexColor(draft.color);
    inputs.y.placeholder = t.yHint;

    // Quick icon and color choices.
    const iconChoices = make("div", "mx-choices");
    for (const choice of this.options.icons ?? DEFAULT_ICONS) {
      const button = this.textButton(choice, "mx-choice", () => {
        inputs.icon.value = choice;
        update();
      });
      button.setAttribute("aria-label", `${t.icon} ${choice}`);
      iconChoices.append(button);
    }
    const colorChoices = make("div", "mx-choices");
    for (const choice of this.options.colors ?? DEFAULT_COLORS) {
      const button = this.textButton("", "mx-choice mx-swatch", () => {
        inputs.color.value = hexColor(choice);
        update();
      });
      button.style.setProperty("--mx-swatch", choice);
      button.setAttribute("aria-label", `${t.color} ${choice}`);
      colorChoices.append(button);
    }
    const groups = make("datalist");
    groups.id = `mx-groups-${Math.random().toString(36).slice(2)}`;
    const known = new Set(this.options.groups ?? []);
    for (const marker of this.viewer.markers.list()) if (marker.group) known.add(marker.group);
    for (const name of known) groups.append(Object.assign(make("option"), { value: name }));
    inputs.group.setAttribute("list", groups.id);

    const position = make("fieldset", "mx-position");
    position.append(make("legend", undefined, t.position));
    const row = make("div", "mx-grid3");
    row.append(
      field(t.x, inputs.x, false),
      field(t.y, inputs.y, false),
      field(t.z, inputs.z, false),
    );
    const current = this.textButton(t.useCurrent, "mx-link", () => {
      const view = this.viewer.view;
      inputs.x.value = String(Math.floor(view.x));
      inputs.z.value = String(Math.floor(view.z));
      update();
    });
    position.append(row, current, make("p", undefined, t.dragHint));

    const extra = new Map<
      string,
      { field: MarkerField; input: HTMLInputElement | HTMLSelectElement }
    >();
    const extraNodes: HTMLElement[] = [];
    for (const definition of this.options.fields ?? []) {
      const value = draft.fields[definition.key];
      let input: HTMLInputElement | HTMLSelectElement;
      if (definition.type === "select") {
        input = make("select");
        for (const option of definition.options ?? [])
          input.append(
            Object.assign(make("option", undefined, option.label), { value: option.value }),
          );
        input.value = value === undefined ? "" : String(value);
      } else {
        input = make("input");
        input.type = definition.type === "checkbox" ? "checkbox" : "text";
        if (definition.type === "number") input.inputMode = "decimal";
        if (definition.type === "checkbox") input.checked = value === true;
        else input.value = value === undefined ? "" : String(value);
      }
      input.name = `field-${definition.key}`;
      extra.set(definition.key, { field: definition, input });
      if (definition.type === "checkbox") {
        const wrapper = make("label", "mx-check");
        wrapper.append(input, document.createTextNode(definition.label));
        extraNodes.push(wrapper);
      } else extraNodes.push(field(definition.label, input));
    }

    const error = make("p", "mx-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const actions = make("div", "mx-actions");
    const save = make("button", "mx-text mx-solid", t.save);
    save.type = "submit";
    actions.append(
      this.textButton(t.cancel, undefined, () => this.surface.closeSheet()),
      save,
    );
    root.append(
      field(t.label, inputs.label),
      field(t.icon, inputs.icon),
      iconChoices,
      field(t.color, inputs.color),
      colorChoices,
      field(t.group, inputs.group),
      groups,
      position,
      ...extraNodes,
      error,
      actions,
    );

    const form: Form = {
      id: draft.id,
      before,
      dimension: draft.dimension,
      base: {
        ...(before?.image === undefined ? {} : { image: before.image }),
        ...(before?.priority === undefined ? {} : { priority: before.priority }),
        ...(before && "data" in before ? { data: before.data } : {}),
      },
      root,
      inputs,
      fields: extra,
      error,
      save,
      saving: false,
      done: false,
    };
    const update = () => {
      const next = this.readDraft(form);
      if (typeof next !== "string") this.viewer.markers.upsert(this.inputOf(form, next));
    };
    root.addEventListener("input", update);
    root.addEventListener("change", update);
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.save(form);
    });
    this.form = form;
    update();
    this.surface.openSheet(
      before ? t.editMarker : t.newMarker,
      root,
      () => this.formClosed(form),
      focusFirst,
    );
  }

  private readDraft(form: Form): MarkerDraft | string {
    const { inputs } = form;
    const whole = (input: HTMLInputElement, optional: boolean): number | undefined | null => {
      const value = input.value.trim().replace("−", "-");
      if (value === "") return optional ? undefined : null;
      if (!/^-?\d+$/.test(value)) return null;
      const parsed = Number(value);
      return Math.abs(parsed) <= LIMIT ? parsed : null;
    };
    const x = whole(inputs.x, false),
      y = whole(inputs.y, true),
      z = whole(inputs.z, false);
    if (x === null || z === null || y === null || x === undefined || z === undefined)
      return this.t.invalidPosition;
    const fields: Record<string, MarkerFieldValue> = {};
    for (const [key, { field, input }] of form.fields) {
      if (field.type === "checkbox") fields[key] = (input as HTMLInputElement).checked;
      else if (field.type === "number") {
        const value = Number(input.value);
        fields[key] = input.value.trim() === "" || !Number.isFinite(value) ? undefined : value;
      } else fields[key] = input.value;
    }
    const label = inputs.label.value.trim(),
      icon = inputs.icon.value.trim(),
      group = inputs.group.value.trim();
    return {
      id: form.id,
      x,
      z,
      dimension: form.dimension,
      ...(y === undefined ? {} : { y }),
      ...(label === "" ? {} : { label }),
      ...(icon === "" ? {} : { icon }),
      color: inputs.color.value,
      ...(group === "" ? {} : { group }),
      fields,
    };
  }

  private inputOf(form: Form, draft: MarkerDraft): MarkerInput {
    return {
      id: draft.id,
      x: draft.x,
      z: draft.z,
      dimension: draft.dimension,
      ...(draft.y === undefined ? {} : { y: draft.y }),
      ...(draft.label === undefined ? {} : { label: draft.label }),
      ...(draft.icon === undefined ? {} : { icon: draft.icon }),
      ...(draft.color === undefined ? {} : { color: draft.color }),
      ...(draft.group === undefined ? {} : { group: draft.group }),
      ...form.base,
    };
  }

  private setSaving(form: Form, saving: boolean): void {
    form.saving = saving;
    form.save.textContent = saving ? this.t.saving : this.t.save;
    for (const element of form.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input, select, button",
    ))
      element.disabled = saving;
  }

  private showError(form: Form, message: string | undefined): void {
    form.error.textContent = message ?? "";
    form.error.hidden = message === undefined;
    if (message !== undefined) form.error.scrollIntoView({ block: "nearest" });
  }

  private async save(form: Form): Promise<void> {
    if (form.saving) return;
    const draft = this.readDraft(form);
    if (typeof draft === "string") return this.showError(form, draft);
    const refused = this.options.validate?.(draft, form.before);
    if (refused !== undefined) return this.showError(form, refused);
    this.showError(form, undefined);
    this.setSaving(form, true);
    let saved: Saved;
    try {
      saved = await (form.before
        ? this.options.onUpdate?.(draft, form.before)
        : this.options.onCreate?.(draft));
    } catch (error) {
      if (this.form !== form) return;
      this.setSaving(form, false);
      return this.showError(form, errorText(error, this.t.saveFailed));
    }
    if (this.form !== form) return;
    const shown = saved ?? this.inputOf(form, draft);
    if (shown.id !== form.id) this.viewer.markers.remove(form.id);
    this.viewer.markers.upsert(shown);
    form.done = true;
    this.surface.closeSheet();
    const marker = this.viewer.markers.get(shown.id);
    if (marker !== undefined) this.showCard(marker);
  }

  /** The sheet closed: a form left without saving puts the marker back as it was. */
  private formClosed(form: Form): void {
    if (this.form === form) this.form = undefined;
    this.drag = undefined;
    if (form.done) return;
    if (form.before !== undefined) this.viewer.markers.upsert(form.before);
    else this.viewer.markers.remove(form.id);
  }

  private textButton(
    label: string,
    className: string | undefined,
    action: (event: MouseEvent) => void,
  ): HTMLButtonElement {
    const button = make("button", className ? `mx-text ${className}` : "mx-text", label);
    button.type = "button";
    button.addEventListener("click", action);
    return button;
  }

  // ── Gestures on the view ──────────────────────────────────────────────────

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointers.add(event.pointerId);
    if (this.pointers.size > 1) {
      this.cancelLongPress();
      this.press = undefined;
      return;
    }
    if (!event.isPrimary || event.button !== 0 || !this.surface.isView(event.target)) return;
    const form = this.form;
    // The marker being edited follows the finger instead of the view.
    if (form !== undefined && !form.saving) {
      const under = this.viewer.markers.markerAt(event.clientX, event.clientY);
      if (under?.id === form.id) {
        event.stopPropagation();
        event.preventDefault();
        this.surface.container.setPointerCapture(event.pointerId);
        this.drag = { pointer: event.pointerId, frame: 0, x: event.clientX, y: event.clientY };
        return;
      }
    }
    this.press = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      moved: false,
      fired: false,
    };
    if (this.editable && form === undefined) {
      clearTimeout(this.longTimer);
      this.longTimer = window.setTimeout(() => {
        const press = this.press;
        if (press === undefined || press.moved || this.pointers.size !== 1) return;
        press.fired = true;
        navigator.vibrate?.(12);
        this.createAt(press.x, press.y);
      }, LONG_PRESS_MS);
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const drag = this.drag;
    if (drag !== undefined && drag.pointer === event.pointerId) {
      event.stopPropagation();
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.frame === 0)
        drag.frame = requestAnimationFrame(() => {
          drag.frame = 0;
          this.moveDraft(drag.x, drag.y);
        });
      return;
    }
    const press = this.press;
    if (
      press !== undefined &&
      press.id === event.pointerId &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) > SLOP
    ) {
      press.moved = true;
      this.cancelLongPress();
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    const drag = this.drag;
    if (drag !== undefined && drag.pointer === event.pointerId) {
      event.stopPropagation();
      cancelAnimationFrame(drag.frame);
      this.moveDraft(event.clientX, event.clientY);
      this.drag = undefined;
      return;
    }
    const press = this.press;
    this.press = undefined;
    this.cancelLongPress();
    if (press === undefined || press.id !== event.pointerId || press.fired || press.moved) return;
    if (performance.now() - press.time > TAP_MS) return;
    if (this.placing) this.createAt(event.clientX, event.clientY);
    // A tap beside every marker closes the card (the layer clears the selection).
    else if (
      this.cardMarker !== undefined &&
      this.viewer.markers.markerAt(event.clientX, event.clientY) === undefined
    )
      this.hideCard();
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.drag?.pointer === event.pointerId) this.drag = undefined;
    if (this.press?.id === event.pointerId) this.press = undefined;
    this.cancelLongPress();
  };

  private readonly cancelLongPress = (): void => {
    clearTimeout(this.longTimer);
    this.longTimer = 0;
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.placing) {
      event.preventDefault();
      this.setPlacing(false);
    }
  };

  /** Moves the marker being edited under a screen point, keeping its Y. */
  private moveDraft(clientX: number, clientY: number): void {
    const form = this.form;
    if (form === undefined) return;
    const block = this.viewer.pickBlock(clientX, clientY);
    if (block === undefined) return;
    form.inputs.x.value = String(block.x);
    form.inputs.z.value = String(block.z);
    const draft = this.readDraft(form);
    if (typeof draft !== "string") this.viewer.markers.upsert(this.inputOf(form, draft));
  }
}
