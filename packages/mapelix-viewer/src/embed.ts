/**
 * The framework-free browser bundle: one ES module, three.js included, for hosts that load the
 * viewer at run time with `import()` from their own origin. It holds the whole browser side of
 * `@mapelix/viewer`: `MapelixViewer` (2D map, 3D world and the switch), the marker layer, the
 * optional controls with the default marker editor, and the 3D engine on its own (`WorldViewer`).
 * Its styles are added at run time, or linked from `mapelix-viewer.css` with
 * `<link rel="stylesheet" data-mapelix-styles>` where inline styles are not allowed.
 */
export * from "./index.js";
export * from "./controls/index.js";
export { WorldViewer } from "./three/world-viewer.js";
export type {
  CameraView,
  Pointed,
  TextureFade,
  TextureMode,
  LeafMode,
  TextureSnapshot,
  TextureState,
  VerticalMovement,
  ViewerSnapshot,
  WorldInfo,
  WorldViewerOptions,
} from "./three/world-viewer.js";
export {
  CAVE_LIMITS,
  type Dimension,
  type SceneContext,
} from "@mapelix/scene-prototype/dimensions";
export {
  DEFAULT_DISCOVERY_FILTERS,
  DISCOVERY_CATEGORIES,
  DISCOVERY_KINDS,
  DISCOVERY_LIMITS,
  type DiscoveryCategory,
  type DiscoveryFilters,
  type DiscoveryGroup,
  type DiscoveryKind,
} from "@mapelix/scene-prototype/discoveries";
export {
  SELECTION_LIMITS,
  selectionAround,
  type HorizontalSelection,
} from "@mapelix/scene-prototype/selection";

/**
 * The version of this bundle's API, so a host can refuse a mismatch. Bumped whenever the
 * exported API changes incompatibly; later builds of one version only add optional members.
 * 4: the bundle is `@mapelix/viewer` itself (see the package README for the changes from 3).
 * 5: block textures (`textures`, `leaves`, `setTextures()`, `setLeaves()`,
 * `WorldStatus.textures`, the textures control texts); a version 4 host keeps working unchanged, with textures off.
 */
export const EMBED_API_VERSION = 5;

/** Whether this browser offers WebGPU or WebGL 2, one of which the 3D view needs. */
export function isViewerSupported(): boolean {
  if (typeof navigator !== "undefined" && "gpu" in navigator) return true;
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    return false;
  }
}
