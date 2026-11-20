import type { Marker, MarkerInput } from "@mapelix/viewer";
import type { MarkerDraft, MarkerEditorOptions } from "@mapelix/viewer/controls";

/**
 * The demo's marker store: the browser's local storage, nothing on a server. A real host saves
 * in its own store, checks rights there, and answers with the marker to show (or throws).
 */
const KEY = "mapelix-demo-markers-v1";

interface Stored {
  readonly markers: MarkerInput[];
}

function isPublic(marker: Marker | MarkerInput): boolean {
  const data = marker.data;
  return typeof data === "object" && data !== null && Reflect.get(data, "public") === true;
}

export class DemoMarkerStore {
  /** One list per world when `worldId` is given. */
  private readonly key: string;
  private markers = new Map<string, MarkerInput>();
  /** Test hook: the next save or delete is refused with this message. */
  failNext: string | undefined;

  constructor(worldId = "") {
    this.key = worldId === "" ? KEY : `${KEY}:${worldId}`;
  }

  /** The stored markers, or `seed` the first time. */
  load(seed: readonly MarkerInput[]): MarkerInput[] {
    let stored: Stored | undefined;
    try {
      const text = localStorage.getItem(this.key);
      stored = text === null ? undefined : (JSON.parse(text) as Stored);
    } catch {
      stored = undefined;
    }
    const markers = Array.isArray(stored?.markers)
      ? stored.markers
      : seed.map((marker) => ({ ...marker, data: { public: true } }));
    this.markers = new Map(markers.map((marker) => [marker.id, marker]));
    return [...this.markers.values()];
  }

  private persist(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify({ markers: [...this.markers.values()] }));
    } catch {
      /* Private browsing: the markers live until the page closes. */
    }
  }

  private async answer(): Promise<void> {
    // A short wait, as a network store would take.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const failure = this.failNext;
    this.failNext = undefined;
    if (failure !== undefined) throw new Error(failure);
  }

  private toInput(draft: MarkerDraft, before?: Marker): MarkerInput {
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
      ...(before?.image === undefined ? {} : { image: before.image }),
      ...(before?.priority === undefined ? {} : { priority: before.priority }),
      data: { public: draft.fields.public === true },
    };
  }

  /** The editor options of the demo: everything but the spawn may change. */
  editor(readOnly: boolean): MarkerEditorOptions {
    return {
      editable: !readOnly,
      canEdit: (marker) => marker.id !== "spawn",
      fields: [
        { key: "public", label: "Public (everyone sees it)", type: "checkbox", default: true },
      ],
      fieldValues: (marker) => ({ public: isPublic(marker) }),
      describe: (marker) => [isPublic(marker) ? "Public" : "Private"],
      groups: ["places", "survey"],
      validate: (draft) => (draft.label === undefined ? "Give the place a name." : undefined),
      onCreate: async (draft) => {
        await this.answer();
        const marker = this.toInput(draft);
        this.markers.set(marker.id, marker);
        this.persist();
        return marker;
      },
      onUpdate: async (draft, before) => {
        await this.answer();
        const marker = this.toInput(draft, before);
        this.markers.set(marker.id, marker);
        this.persist();
        return marker;
      },
      onDelete: async (marker) => {
        await this.answer();
        this.markers.delete(marker.id);
        this.persist();
      },
    };
  }
}
