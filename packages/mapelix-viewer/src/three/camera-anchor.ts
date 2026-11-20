import type { Vector3 } from "three/webgpu";

/**
 * Moves the orbit point to `reach` blocks from the camera along the line from the camera to it.
 *
 * A perspective view looks the same afterwards, since the camera stays where it is. A view with
 * an orthographic share draws at a scale set by the orbit distance (`ViewCamera.focusDistance`),
 * so with `keepDistance` the camera slides along the same line instead and keeps that distance:
 * an orthographic view is unchanged by a move along its view direction.
 */
export function retarget(
  camera: Vector3,
  target: Vector3,
  reach: number,
  keepDistance: boolean,
): void {
  const distance = camera.distanceTo(target);
  if (!(distance > 1e-6)) return;
  const direction = target.clone().sub(camera).divideScalar(distance);
  target.copy(camera).addScaledVector(direction, reach);
  if (keepDistance) camera.copy(target).addScaledVector(direction, -distance);
}
