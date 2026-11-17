/** Every text of the marker editor; hosts pass their own, English fills the rest. */
export interface MarkerEditorTexts {
  readonly add: string;
  readonly placePrompt: string;
  readonly newMarker: string;
  readonly editMarker: string;
  readonly untitled: string;
  readonly card: string;
  readonly edit: string;
  readonly delete: string;
  readonly confirmDelete: (label: string) => string;
  readonly cancel: string;
  readonly save: string;
  readonly saving: string;
  readonly label: string;
  readonly icon: string;
  readonly color: string;
  readonly group: string;
  readonly position: string;
  readonly x: string;
  readonly y: string;
  readonly yHint: string;
  readonly z: string;
  readonly useCurrent: string;
  readonly dragHint: string;
  readonly coordinates: (x: number, z: number, y?: number) => string;
  readonly groupLine: (group: string) => string;
  readonly invalidPosition: string;
  readonly saveFailed: string;
  readonly deleteFailed: string;
  readonly readOnly: string;
}

export const DEFAULT_MARKER_EDITOR_TEXTS: MarkerEditorTexts = {
  add: "Add a marker",
  placePrompt: "Tap the map where the marker goes, or press and hold anywhere.",
  newMarker: "New marker",
  editMarker: "Edit marker",
  untitled: "Marker",
  card: "Selected marker",
  edit: "Edit",
  delete: "Delete",
  confirmDelete: (label) => `Delete “${label}”? This cannot be undone.`,
  cancel: "Cancel",
  save: "Save",
  saving: "Saving…",
  label: "Label",
  icon: "Icon",
  color: "Color",
  group: "Group",
  position: "Position",
  x: "X",
  y: "Y (optional)",
  yHint: "Empty: on the ground",
  z: "Z",
  useCurrent: "Use the current position",
  dragHint: "Or drag the marker on the map.",
  coordinates: (x, z, y) => (y === undefined ? `X ${x} · Z ${z}` : `X ${x} · Y ${y} · Z ${z}`),
  groupLine: (group) => `Group: ${group}`,
  invalidPosition: "Enter whole numbers for X and Z (and Y, if set).",
  saveFailed: "The marker could not be saved.",
  deleteFailed: "The marker could not be deleted.",
  readOnly: "This marker cannot be changed here.",
};
