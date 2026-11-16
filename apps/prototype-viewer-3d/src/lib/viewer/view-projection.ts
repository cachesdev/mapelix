import { MathUtils, Matrix4, PerspectiveCamera, Ray, WebGPUCoordinateSystem } from "three/webgpu";

/** How the 3D view projects the world onto the screen. */
export type ViewProjection = "perspective" | "isometric";

/**
 * Optional automatic perspective inside an isometric view. Each rule is off when undefined;
 * the chosen projection returns once the view leaves the rule's range again.
 */
export interface AutoPerspective {
  /** Use perspective while the view is closer than this, in CSS pixels per block. */
  readonly abovePixelsPerBlock?: number;
  /** Use perspective while the camera looks down by less than this, in radians. */
  readonly belowPitch?: number;
}

/** Duration of an animated projection change, in seconds. */
export const PROJECTION_TRANSITION_SECONDS = 0.6;
/** Rules release slightly past their threshold, so a view at the limit does not flicker. */
const HYSTERESIS = 0.08;

const ortho = new Matrix4();

/**
 * A perspective camera that can blend into an orthographic projection.
 *
 * `projectionBlend` 0 is the unchanged perspective projection and 1 an orthographic one whose
 * visible height equals the perspective view's height at `focusDistance`. In between, the
 * clip coordinates are a weighted sum of both projections: the focus plane keeps its scale
 * throughout, the near and far planes keep their depths, and the result looks like the camera
 * backing away while narrowing its field of view. The camera stays at its orbit position, so
 * near-plane clipping, fog and lighting distances do not jump.
 */
export class ViewCamera extends PerspectiveCamera {
  /** 0 is perspective, 1 orthographic. */
  projectionBlend = 0;
  /** Distance from the camera to the plane whose scale is kept, in world units. */
  focusDistance = 1;

  /** True while any orthographic share is in the projection. */
  get blended(): boolean {
    return this.projectionBlend > 0;
  }

  override updateProjectionMatrix(): void {
    super.updateProjectionMatrix();
    const blend = MathUtils.clamp(this.projectionBlend, 0, 1);
    // `super` may run from the base constructor before the fields are initialized.
    if (!(blend > 0)) return;
    const distance = Math.max(this.focusDistance, 1e-6);
    const top = (distance * Math.tan(MathUtils.DEG2RAD * 0.5 * this.fov)) / this.zoom;
    const right = top * this.aspect;
    // An isometric view stands for a viewer far away: ground between the camera and the
    // bottom of the screen lies behind the camera, so the near plane moves back by `far`.
    // While blending, the near clip then sits where the scale is at most twice the focus one.
    ortho.makeOrthographic(
      -right,
      right,
      top,
      -top,
      this.near - this.far,
      this.far,
      this.coordinateSystem,
      this.reversedDepth,
    );
    if (blend >= 1) this.projectionMatrix.copy(ortho);
    else {
      const target = this.projectionMatrix.elements;
      const source = ortho.elements;
      // Scaling the orthographic part by the focus distance makes both agree on the focus plane.
      for (let index = 0; index < 16; index += 1)
        target[index] = (1 - blend) * target[index]! + blend * distance * source[index]!;
    }
    this.projectionMatrixInverse.copy(this.projectionMatrix).invert();
  }
}

/** How far a ray from `projectionRay` reaches to cover everything drawn. */
export function rayReach(camera: PerspectiveCamera): number {
  return camera instanceof ViewCamera && camera.blended ? 2 * camera.far : camera.far;
}

/** Eases a projection transition: slow at both ends. */
export function easeProjection(progress: number): number {
  const t = MathUtils.clamp(progress, 0, 1);
  return t * t * (3 - 2 * t);
}

/** CSS pixels per block on the focus plane for a view `distance` blocks away. */
export function pixelsPerBlock(distance: number, fovDegrees: number, cssHeight: number): number {
  return (
    cssHeight / (2 * Math.max(distance, 1e-6) * Math.tan(MathUtils.DEG2RAD * fovDegrees * 0.5))
  );
}

/** The orbit distance that shows `pixels` CSS pixels per block on the focus plane. */
export function distanceForPixelsPerBlock(
  pixels: number,
  fovDegrees: number,
  cssHeight: number,
): number {
  return cssHeight / (2 * Math.max(pixels, 1e-6) * Math.tan(MathUtils.DEG2RAD * fovDegrees * 0.5));
}

/**
 * The projection to show for a chosen projection, current zoom and pitch. `current` is the
 * projection shown now; a rule that already applies releases only past its threshold.
 */
export function effectiveProjection(
  chosen: ViewProjection,
  current: ViewProjection,
  view: { readonly pixelsPerBlock: number; readonly pitch: number },
  rules: AutoPerspective | undefined,
): ViewProjection {
  if (chosen === "perspective" || rules === undefined) return chosen;
  const keep = current === "perspective" ? 1 + HYSTERESIS : 1;
  const zoom = rules.abovePixelsPerBlock;
  const pitch = rules.belowPitch;
  if (zoom !== undefined && view.pixelsPerBlock * keep > zoom) return "perspective";
  if (pitch !== undefined && view.pitch < pitch * keep) return "perspective";
  return "isometric";
}

/**
 * Screen pixels covered by `size` blocks at view-space depth `depth` in front of the camera.
 * `scale` is the drawing-buffer height divided by twice the tangent of half the field of view.
 */
export function projectedPixels(
  size: number,
  depth: number,
  scale: number,
  blend: number,
  focusDistance: number,
): number {
  if (blend <= 0) return (size * scale) / depth;
  // Both parts agree on clip x and y; only clip w blends, from depth to the focus distance.
  return (size * scale) / ((1 - blend) * depth + blend * focusDistance);
}

/**
 * The ray through a canvas point, in client pixels. For blended and orthographic views it
 * starts on the near plane, so rays at the screen edges stay parallel to the view direction.
 */
export function projectionRay(
  camera: ViewCamera | PerspectiveCamera,
  element: Element,
  clientX: number,
  clientY: number,
): Ray {
  const bounds = element.getBoundingClientRect();
  const x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  const y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
  const ray = new Ray();
  if (!(camera instanceof ViewCamera) || !camera.blended) {
    ray.origin.setFromMatrixPosition(camera.matrixWorld);
    ray.direction.set(x, y, 0.5).unproject(camera).sub(ray.origin).normalize();
    return ray;
  }
  // WebGPU clip depth starts at 0, WebGL at -1; 0.5 lies inside both.
  const near = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
  ray.origin.set(x, y, near).unproject(camera);
  ray.direction.set(x, y, 0.5).unproject(camera).sub(ray.origin).normalize();
  return ray;
}
