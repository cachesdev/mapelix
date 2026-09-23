import { MapControls } from "three/addons/controls/MapControls.js";
import { MathUtils, Quaternion, Ray, Vector3, type PerspectiveCamera } from "three/webgpu";

import type { SurfaceHit } from "./quad-collider";

/** What the camera reads from the loaded terrain. */
export interface Terrain {
  /** Height of the highest block at a column, once its region is loaded. */
  heightAt(x: number, z: number): number | undefined;
  /** The nearest surface along a ray, with `radius` blocks of room around the ray. */
  raycast(
    origin: Vector3,
    direction: Vector3,
    far: number,
    radius?: number,
  ): SurfaceHit | undefined;
}

export interface CameraView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly distance: number;
  /** Radians clockwise from north. */
  readonly heading: number;
  /** Radians above the horizon. */
  readonly pitch: number;
}

interface Flight {
  readonly fromTarget: Vector3;
  readonly toTarget: Vector3;
  readonly offset: Vector3;
  /** How much the camera rises halfway through, as a multiple of its distance. */
  readonly lift: number;
  readonly seconds: number;
  elapsed: number;
}

const UP = new Vector3(0, 1, 0);
/** Room kept above the highest block while the camera settles after a jump, in blocks. */
const CLEARANCE = 2.5;
/** Room kept around the camera, as a multiple of its near plane distance. */
const NEAR_ROOM = 1.5;
/** How far the camera stops short of a face it runs into, in blocks. */
const SKIN = 0.02;
/** Distance change per 100 pixels of wheel travel. */
const WHEEL_ZOOM = 0.95 ** -1.1;
/** Farthest the camera orbits from the point it looks at, in blocks. */
export const ZOOM_LIMIT = 2600;
/** The zoom limit while zooming out is unlocked. */
const UNLOCKED_ZOOM_LIMIT = 20_000;
const MOVE_KEYS = new Set([
  ...["KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "KeyR", "KeyF"],
  ...["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
]);

/**
 * Map-style camera: left drag pans, right drag orbits, and the wheel zooms toward the
 * surface under the cursor. Each drag, wheel step, or key press puts the orbit point on
 * the first surface in the middle of the view. The camera slides along surfaces it runs
 * into and climbs walls. Keyboard keys pan (WASD), turn (Q and E), and zoom (R and F).
 */
export class CameraRig {
  private readonly camera: PerspectiveCamera;
  private readonly element: HTMLElement;
  private readonly controls: MapControls;
  private readonly terrain: Terrain;
  private readonly keys = new Set<string>();
  private readonly lastPosition = new Vector3();
  private readonly lastTarget = new Vector3();
  /** Where the camera last stood clear of the terrain. Collisions sweep from here. */
  private readonly clearPosition = new Vector3();
  private flight: Flight | undefined;
  /** After a jump, the orbit point eases onto the ground until the user takes over. */
  private settling = false;

  constructor(camera: PerspectiveCamera, element: HTMLElement, terrain: Terrain) {
    this.camera = camera;
    this.element = element;
    this.terrain = terrain;
    this.controls = new MapControls(camera, element);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = false;
    // Wheel zoom is handled here. Pinch zoom on touch screens still goes to MapControls.
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = ZOOM_LIMIT;
    this.controls.minPolarAngle = 0.04;
    this.controls.maxPolarAngle = 1.42;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener("start", () => this.takeOver());

    // The capture phase runs before the MapControls wheel listener on the same element.
    element.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  get focus(): Vector3 {
    return this.controls.target;
  }

  get distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** Radians clockwise from north (negative z), the direction the camera faces. */
  get heading(): number {
    return MathUtils.euclideanModulo(-this.controls.getAzimuthalAngle(), Math.PI * 2);
  }

  /** Radians above the horizon that the camera looks down from. */
  get pitch(): number {
    return Math.PI / 2 - this.controls.getPolarAngle();
  }

  /**
   * Places the camera `distance` blocks from a point, facing `heading` and looking down by
   * `pitch`. With `settle`, the point then eases onto the ground once its region loads.
   */
  setView(view: CameraView, options: { readonly settle: boolean }): void {
    const azimuth = -view.heading;
    const pitch = MathUtils.clamp(
      view.pitch,
      Math.PI / 2 - this.controls.maxPolarAngle,
      Math.PI / 2 - this.controls.minPolarAngle,
    );
    this.flight = undefined;
    this.settling = options.settle;
    this.controls.target.set(view.x, view.y, view.z);
    this.camera.position.set(
      view.x + Math.sin(azimuth) * Math.cos(pitch) * view.distance,
      view.y + Math.sin(pitch) * view.distance,
      view.z + Math.cos(azimuth) * Math.cos(pitch) * view.distance,
    );
    this.controls.update();
    this.clearPosition.copy(this.camera.position);
  }

  /** Lets the camera zoom out past the usual limit. Locking again brings it back within it. */
  setZoomUnlocked(unlocked: boolean): void {
    this.controls.maxDistance = unlocked ? UNLOCKED_ZOOM_LIMIT : ZOOM_LIMIT;
  }

  /** Glides to a column, arcing higher for longer trips so the terrain stays readable. */
  flyTo(x: number, z: number): void {
    const fromTarget = this.controls.target.clone();
    const toTarget = new Vector3(x, this.terrain.heightAt(x, z) ?? fromTarget.y, z);
    const travel = fromTarget.distanceTo(toTarget);
    this.settling = false;
    this.flight = {
      fromTarget,
      toTarget,
      offset: this.camera.position.clone().sub(fromTarget),
      lift: Math.min(3, travel / 500),
      seconds: MathUtils.clamp(0.8 + travel / 2500, 0.8, 2.6),
      elapsed: 0,
    };
  }

  zoom(factor: number): void {
    this.takeOver();
    this.zoomAbout(this.controls.target, factor);
  }

  faceNorth(): void {
    this.takeOver();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const horizontal = Math.hypot(offset.x, offset.z);
    offset.set(0, offset.y, horizontal);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  /** Advances input and flights. Returns whether the camera moved this frame. */
  update(delta: number): boolean {
    this.fly(delta);
    this.applyKeys(delta);
    this.controls.update(delta);
    // Flights arc over the terrain on their own.
    if (this.flight === undefined) {
      if (this.settling) this.settle(delta);
      else this.collide();
    }
    this.clearPosition.copy(this.camera.position);

    const moved =
      this.camera.position.distanceToSquared(this.lastPosition) > 1e-6 ||
      this.controls.target.distanceToSquared(this.lastTarget) > 1e-6;
    this.lastPosition.copy(this.camera.position);
    this.lastTarget.copy(this.controls.target);
    return moved;
  }

  dispose(): void {
    this.controls.dispose();
    this.element.removeEventListener("wheel", this.onWheel, { capture: true });
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
  }

  /** Hands the camera to the user: stops any jump and puts the orbit point on what they see. */
  private takeOver(): void {
    this.flight = undefined;
    this.settling = false;
    const { minDistance, maxDistance, target } = this.controls;
    // The camera looks at the orbit point, so moving it along the view ray keeps the view.
    const direction = target.clone().sub(this.camera.position).normalize();
    const hit = this.terrain.raycast(this.camera.position, direction, maxDistance);
    if (hit === undefined) return;
    target
      .copy(this.camera.position)
      .addScaledVector(direction, Math.max(hit.distance, minDistance));
  }

  /** Scales the view about a point, so the point stays at the same place on screen. */
  private zoomAbout(anchor: Vector3, factor: number): void {
    const { minDistance, maxDistance, target } = this.controls;
    const distance = this.distance;
    const scale = MathUtils.clamp(distance * factor, minDistance, maxDistance) / distance;
    this.camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
    target.sub(anchor).multiplyScalar(scale).add(anchor);
  }

  private fly(delta: number): void {
    const flight = this.flight;
    if (flight === undefined) return;
    flight.elapsed = Math.min(flight.seconds, flight.elapsed + delta);
    const progress = flight.elapsed / flight.seconds;
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    this.controls.target.lerpVectors(flight.fromTarget, flight.toTarget, eased);
    const rise = 1 + Math.sin(progress * Math.PI) * flight.lift;
    this.camera.position.copy(this.controls.target).addScaledVector(flight.offset, rise);
    if (progress < 1) return;
    this.flight = undefined;
    this.settling = true;
  }

  private applyKeys(delta: number): void {
    if (this.keys.size === 0) return;
    const forward = new Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new Vector3().crossVectors(forward, UP);
    const speed = Math.max(24, this.distance * 1.1) * delta;
    const move = new Vector3();
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) move.add(forward);
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) move.sub(forward);
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) move.add(right);
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) move.sub(right);
    if (move.lengthSq() > 0) {
      move.normalize().multiplyScalar(speed);
      this.controls.target.add(move);
      this.camera.position.add(move);
    }

    const turn = (Number(this.keys.has("KeyQ")) - Number(this.keys.has("KeyE"))) * 1.4 * delta;
    if (turn !== 0) {
      const offset = this.camera.position.clone().sub(this.controls.target);
      offset.applyQuaternion(new Quaternion().setFromAxisAngle(UP, turn));
      this.camera.position.copy(this.controls.target).add(offset);
    }
    const zoom = Number(this.keys.has("KeyF")) - Number(this.keys.has("KeyR"));
    if (zoom !== 0) this.zoomAbout(this.controls.target, 1 + zoom * 1.6 * delta);
  }

  /** Eases the orbit point onto the ground and keeps the camera above the highest block. */
  private settle(delta: number): void {
    const target = this.controls.target;
    const ground = this.terrain.heightAt(target.x, target.z);
    if (ground !== undefined) {
      const rise = (ground - target.y) * Math.min(1, delta * 5);
      target.y += rise;
      this.camera.position.y += rise;
    }
    const below = this.terrain.heightAt(this.camera.position.x, this.camera.position.z);
    if (below !== undefined && this.camera.position.y < below + CLEARANCE) {
      this.camera.position.y = below + CLEARANCE;
    }
  }

  /** Keeps the camera out of the terrain by sweeping it from where it last stood clear. */
  private collide(): void {
    const position = this.camera.position;
    const correction = this.sweep(this.clearPosition, position).sub(position);
    if (correction.lengthSq() < 1e-12) return;
    position.add(correction);
    // A pan moves the orbit point with the camera, so it takes the same correction.
    if (!this.controls.target.equals(this.lastTarget)) this.controls.target.add(correction);
    this.camera.lookAt(this.controls.target);
  }

  /**
   * Moves from `from` toward `to` and stops short of the first face in the way. The rest
   * of the motion slides along the face, and a wall turns it into a climb, so the camera
   * rises over steps and walls instead of sticking to them.
   */
  private sweep(from: Vector3, to: Vector3): Vector3 {
    const radius = this.camera.near * NEAR_ROOM;
    const position = from.clone();
    const motion = to.clone().sub(from);
    const direction = new Vector3();
    // Three bounces cover a corner, where a face on every axis stops the camera.
    for (let bounce = 0; bounce < 3; bounce += 1) {
      const length = motion.length();
      if (length < 1e-6) break;
      direction.copy(motion).divideScalar(length);
      const hit = this.terrain.raycast(position, direction, length, radius);
      if (hit === undefined) {
        position.add(motion);
        break;
      }
      const travel = Math.max(0, hit.distance - SKIN);
      position.addScaledVector(direction, travel);
      motion.multiplyScalar(1 - travel / length);
      const blocked = Math.abs(motion.getComponent(hit.axis));
      motion.setComponent(hit.axis, 0);
      if (hit.axis !== 1) motion.y += blocked;
    }
    return position;
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
    this.takeOver();
    const ray = pointerRay(this.camera, this.element, event.clientX, event.clientY);
    const hit = this.terrain.raycast(ray.origin, ray.direction, this.camera.far);
    const anchor =
      hit === undefined ? this.controls.target.clone() : ray.at(hit.distance, new Vector3());
    this.zoomAbout(anchor, WHEEL_ZOOM ** (wheelPixels(event) / 100));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || !MOVE_KEYS.has(event.code)) return;
    if (!this.keys.has(event.code)) this.takeOver();
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}

/** The ray from the camera through a point on the canvas, in client pixels. */
export function pointerRay(
  camera: PerspectiveCamera,
  element: HTMLElement,
  clientX: number,
  clientY: number,
): Ray {
  const bounds = element.getBoundingClientRect();
  const x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  const y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
  const ray = new Ray();
  ray.origin.setFromMatrixPosition(camera.matrixWorld);
  ray.direction.set(x, y, 0.5).unproject(camera).sub(ray.origin).normalize();
  return ray;
}

/** Wheel travel in pixels. Touchpad pinches arrive as small wheel steps with Ctrl held. */
function wheelPixels(event: WheelEvent): number {
  const unit =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? 16
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? 100
        : 1;
  return event.deltaY * unit * (event.ctrlKey ? 10 : 1);
}
