import { MapControls } from "three/addons/controls/MapControls.js";
import {
  MathUtils,
  MOUSE,
  Plane,
  Quaternion,
  Vector3,
  type PerspectiveCamera,
  type Ray,
} from "three/webgpu";

import type { SurfaceHit } from "./quad-collider";
import { CAVE_LIMITS, type VerticalBounds } from "@mapelix/scene-prototype/dimensions";
import { projectionRay, rayReach, ViewCamera } from "./view-projection";
import { HeldKeys, keyboardSpeed } from "./camera-input";

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
const VERTICAL_KEYS = new Set(["Space", "KeyC", "PageUp", "PageDown"]);
export type VerticalMovement = -1 | 0 | 1;
export type CameraInteraction = "pan" | "zoom" | "rotate" | "click";

/**
 * Map-style camera: left drag pans, right drag orbits, and the wheel zooms toward the
 * surface under the cursor. Each drag, wheel step, or key press puts the orbit point on
 * the first surface in the middle of the view. The camera slides along surfaces it runs
 * into and climbs walls. Keyboard keys pan (WASD), turn (Q and E), and zoom (R and F).
 * Caves retain their pivot, allow passage through walls, and add Space/C movement.
 */
export class CameraRig {
  private readonly camera: PerspectiveCamera;
  private readonly element: HTMLElement;
  private readonly controls: MapControls;
  private readonly terrain: Terrain;
  private readonly keys = new HeldKeys();
  private readonly lastPosition = new Vector3();
  private readonly lastTarget = new Vector3();
  /** Where the camera last stood clear of the terrain. Collisions sweep from here. */
  private readonly clearPosition = new Vector3();
  private flight: Flight | undefined;
  /** After a jump, the orbit point eases onto the ground until the user takes over. */
  private settling = false;
  private window: VerticalBounds | undefined;
  private zoomUnlocked = false;
  private enabled = true;
  private heldVertical: VerticalMovement = 0;
  private readonly pointers = new Set<number>();
  private gesture:
    | { id: number; x: number; y: number; action: CameraInteraction; moved: boolean }
    | undefined;
  private pinned = false;

  constructor(
    camera: PerspectiveCamera,
    element: HTMLElement,
    terrain: Terrain,
    private readonly onInteraction?: (interaction: CameraInteraction) => void,
  ) {
    this.camera = camera;
    this.element = element;
    this.terrain = terrain;
    this.controls = new ViewMapControls(camera, element);
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

    // The capture phase runs before the MapControls wheel listener on the same element.
    element.addEventListener("wheel", this.onWheel, { capture: true, passive: false });
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("pointerdown", this.onPointerDown, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
    window.addEventListener("pointerup", this.onPointerUp, true);
    window.addEventListener("pointercancel", this.onPointerCancel, true);
    window.addEventListener("focusin", this.onFocusIn);
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

  /** Input intent remains available when the focus reaches a slice boundary. */
  get verticalMovement(): VerticalMovement {
    if (!this.enabled || !this.window) return 0;
    return Math.sign(
      this.heldVertical +
        Number(this.keys.has("Space") || this.keys.has("PageUp")) -
        Number(this.keys.has("KeyC") || this.keys.has("PageDown")),
    ) as VerticalMovement;
  }

  /** Held touch/button input, stopped on release, blur, or a view change. */
  setVerticalMovement(direction: VerticalMovement): void {
    this.heldVertical = this.enabled && this.window ? direction : 0;
    if (this.heldVertical) {
      this.interact("pan");
      this.takeOver();
    }
  }

  /** Keep the selected point as the orbit pivot, including Surface views. */
  setFocusPinned(pinned: boolean): void {
    this.pinned = pinned;
    this.controls.minDistance = pinned ? 1.5 : Math.min(6, Math.max(1.5, this.distance));
    if (pinned) {
      this.flight = undefined;
      this.settling = false;
    }
  }

  /**
   * Places the camera `distance` blocks from a point, facing `heading` and looking down by
   * `pitch`. With `settle`, the point then eases onto the ground once its region loads.
   */
  setView(view: CameraView, options: { readonly settle: boolean }): void {
    // Drain old pan/rotation damping before applying an explicit pose or recovery.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    const azimuth = -view.heading;
    const pitch = MathUtils.clamp(
      view.pitch,
      Math.PI / 2 - this.controls.maxPolarAngle,
      Math.PI / 2 - this.controls.minPolarAngle,
    );
    this.flight = undefined;
    this.settling = options.settle && this.window === undefined;
    const y = this.window
      ? MathUtils.clamp(view.y, this.window.minY, this.window.maxY - 1)
      : view.y;
    this.controls.target.set(view.x, y, view.z);
    const distance =
      this.window === undefined
        ? view.distance
        : MathUtils.clamp(view.distance, this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.set(
      view.x + Math.sin(azimuth) * Math.cos(pitch) * distance,
      y + Math.sin(pitch) * distance,
      view.z + Math.cos(azimuth) * Math.cos(pitch) * distance,
    );
    this.controls.update();
    this.clearPosition.copy(this.camera.position);
  }

  /** Lets the camera zoom out past the usual limit. Locking again brings it back within it. */
  setZoomUnlocked(unlocked: boolean): void {
    this.zoomUnlocked = unlocked;
    this.controls.maxDistance =
      this.window === undefined
        ? unlocked
          ? UNLOCKED_ZOOM_LIMIT
          : ZOOM_LIMIT
        : CAVE_LIMITS.viewDistance * 0.75;
  }

  /** Cave focus stays in the selected slice and never settles onto a surface heightmap. */
  setVerticalWindow(window: VerticalBounds | undefined, preserveMovement = false): void {
    if (!preserveMovement) this.stopMovement();
    this.window = window;
    if (window !== undefined) this.settling = false;
    this.setZoomUnlocked(this.zoomUnlocked);
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
      lift: this.window === undefined ? Math.min(3, travel / 500) : 0,
      seconds: MathUtils.clamp(0.8 + travel / 2500, 0.8, 2.6),
      elapsed: 0,
    };
  }

  zoom(factor: number): void {
    this.interact("zoom");
    this.takeOver();
    this.zoomAbout(this.controls.target, factor);
  }

  faceNorth(): void {
    this.interact("rotate");
    this.takeOver();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const horizontal = Math.hypot(offset.x, offset.z);
    offset.set(0, offset.y, horizontal);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  /** Advances input and flights. Returns whether the camera moved this frame. */
  update(delta: number): boolean {
    if (!this.enabled) return false;
    this.keys.expire(performance.now());
    this.fly(delta);
    this.applyKeys(delta);
    const vertical = this.verticalMovement;
    if (vertical) {
      this.interact("pan");
      const step = vertical * 12 * delta;
      this.controls.target.y += step;
      this.camera.position.y += step;
    }
    this.controls.update(delta);
    // Flights arc over the terrain on their own.
    if (this.flight === undefined) {
      if (this.settling) this.settle(delta);
      else if (this.window === undefined && !this.pinned) this.collide();
    }
    if (this.window !== undefined) {
      const y = MathUtils.clamp(this.controls.target.y, this.window.minY, this.window.maxY - 1);
      this.camera.position.y += y - this.controls.target.y;
      this.controls.target.y = y;
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
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    window.removeEventListener("pointerdown", this.onPointerDown, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
    window.removeEventListener("pointerup", this.onPointerUp, true);
    window.removeEventListener("pointercancel", this.onPointerCancel, true);
    window.removeEventListener("focusin", this.onFocusIn);
  }

  /** Suspend orbit/keyboard input while a selection handle owns the pointer. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.controls.enabled = enabled;
    if (!enabled) this.stopMovement();
  }

  stopMovement(): void {
    this.keys.clear();
    this.pointers.clear();
    this.gesture = undefined;
    this.heldVertical = 0;
  }

  /** Hands the camera to the user: stops any jump and puts the orbit point on what they see. */
  private takeOver(): void {
    this.flight = undefined;
    this.settling = false;
    // Cave navigation may pass through rock. Retargeting onto a nearby wall would
    // repeatedly move the orbit pivot and trap the camera in narrow passages.
    if (this.window !== undefined || this.pinned) return;
    const { minDistance, target } = this.controls;
    // The camera looks at the orbit point, so moving it along the view ray keeps the view.
    const direction = target.clone().sub(this.camera.position).normalize();
    const hit = this.terrain.raycast(this.camera.position, direction, this.anchorReach());
    if (hit === undefined) return;
    target
      .copy(this.camera.position)
      .addScaledVector(direction, Math.max(hit.distance, minDistance));
  }

  /** A local gesture must not replace its pivot with distant terrain on the horizon. */
  private anchorReach(): number {
    return Math.min(this.controls.maxDistance, this.distance * 2);
  }

  /** Scales the view about a point, so the point stays at the same place on screen. */
  private zoomAbout(anchor: Vector3, factor: number): void {
    const { minDistance, maxDistance, target } = this.controls;
    // A far anchor sets the pace, so a pivot close to the camera cannot stall the zoom.
    const reach = Math.max(this.distance, this.camera.position.distanceTo(anchor));
    const scale = MathUtils.clamp(reach * factor, minDistance, maxDistance) / reach;
    this.camera.position.sub(anchor).multiplyScalar(scale).add(anchor);
    target.sub(anchor).multiplyScalar(scale).add(anchor);
    // Keep the pivot ahead of the camera, on the same view direction.
    const distance = this.distance;
    if (distance > 1e-6 && distance < minDistance) {
      const direction = target.clone().sub(this.camera.position).divideScalar(distance);
      target.copy(this.camera.position).addScaledVector(direction, minDistance);
    }
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
    this.settling = this.window === undefined;
  }

  private applyKeys(delta: number): void {
    if (this.keys.size === 0) return;
    const forward = new Vector3();
    this.camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    const right = new Vector3().crossVectors(forward, UP);
    // Over high terrain the pivot can sit close to the camera; the height above the
    // ground below restores the pace once the camera is past it.
    const ground = this.terrain.heightAt(this.camera.position.x, this.camera.position.z);
    const altitude = ground === undefined ? 0 : this.camera.position.y - ground;
    const reach = Math.max(this.distance, altitude);
    const speed = keyboardSpeed(reach, this.window !== undefined) * delta;
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
    if (!this.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.interact("zoom");
    this.takeOver();
    const ray = pointerRay(this.camera, this.element, event.clientX, event.clientY);
    // Zoom toward what is under the cursor, however far; only the pivot stays local.
    const hit = this.terrain.raycast(ray.origin, ray.direction, rayReach(this.camera));
    const anchor =
      hit === undefined ? this.controls.target.clone() : ray.at(hit.distance, new Vector3());
    this.zoomAbout(anchor, WHEEL_ZOOM ** (wheelPixels(event) / 100));
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (
      !this.enabled ||
      document.hidden ||
      event.defaultPrevented ||
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLSelectElement ||
      event.target instanceof HTMLTextAreaElement ||
      (event.target instanceof HTMLElement && event.target.isContentEditable) ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (VERTICAL_KEYS.has(event.code) && !this.navigationTarget(event.target)) ||
      (!MOVE_KEYS.has(event.code) && !(this.window && VERTICAL_KEYS.has(event.code)))
    )
      return;
    event.preventDefault();
    this.interact(
      event.code === "KeyQ" || event.code === "KeyE"
        ? "rotate"
        : event.code === "KeyR" || event.code === "KeyF"
          ? "zoom"
          : "pan",
    );
    if (!this.keys.has(event.code)) this.takeOver();
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private navigationTarget(target: EventTarget | null): boolean {
    return (
      target === window ||
      target === document ||
      target === document.body ||
      target === document.documentElement ||
      target === this.element ||
      (target instanceof HTMLElement && target === this.element.closest('[role="application"]'))
    );
  }

  private interact(action: CameraInteraction): void {
    this.onInteraction?.(action);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointers.add(event.pointerId);
    if (!(event.target instanceof Node) || !this.element.contains(event.target)) return;
    // A plain click cancels a flight without moving either the camera or its pivot.
    this.flight = undefined;
    this.settling = false;
    // Compensate MapControls' built-in Shift swap through its public mapping.
    // Ctrl/Meta retain their existing behavior; Shift has no navigation action.
    const swap = event.shiftKey && !event.ctrlKey && !event.metaKey;
    this.controls.mouseButtons.LEFT = swap ? MOUSE.ROTATE : MOUSE.PAN;
    this.controls.mouseButtons.RIGHT = swap ? MOUSE.PAN : MOUSE.ROTATE;
    const rotate = (event.button === 2) !== (event.ctrlKey || event.metaKey);
    this.gesture = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      action: event.button === 1 || this.pointers.size > 1 ? "zoom" : rotate ? "rotate" : "pan",
      moved: false,
    };
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    const gesture = this.gesture;
    if (this.enabled && gesture && this.pointers.size > 1 && this.pointers.has(event.pointerId)) {
      if (!gesture.moved) this.takeOver();
      gesture.moved = true;
      this.interact("zoom");
      return;
    }
    if (
      !this.enabled ||
      !gesture ||
      gesture.id !== event.pointerId ||
      gesture.moved ||
      Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 4
    )
      return;
    gesture.moved = true;
    this.takeOver();
    this.interact(gesture.action);
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.gesture?.id !== event.pointerId) return;
    if (this.enabled && !this.gesture.moved) this.interact("click");
    this.gesture = undefined;
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    this.pointers.delete(event.pointerId);
    if (this.gesture?.id === event.pointerId) this.gesture = undefined;
  };

  private readonly onFocusIn = (event: FocusEvent): void => {
    if (!this.navigationTarget(event.target)) {
      // A host pointer button may start held vertical input before it receives focus.
      this.keys.clear();
    }
  };

  private readonly onBlur = (): void => {
    this.stopMovement();
  };

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) this.stopMovement();
  };
}

/**
 * The ray from the camera through a point on the canvas, in client pixels. Isometric and
 * blended views start it on the near plane; see `projectionRay`.
 */
export function pointerRay(
  camera: PerspectiveCamera,
  element: HTMLElement,
  clientX: number,
  clientY: number,
): Ray {
  return projectionRay(camera, element, clientX, clientY);
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

/**
 * MapControls drags the ground under the pointer with a ray from the camera position, which
 * only fits a perspective projection. Blended and isometric views cast the pointer ray through
 * the projection actually drawn; perspective keeps the original code.
 */
class ViewMapControls extends MapControls {
  declare protected _panOffset: Vector3;
  declare protected _panWorldStart: Vector3;
  private readonly panPlane = new Plane();
  private readonly panPoint = new Vector3();

  protected _handleMouseDownPan(event: PointerEvent): void {
    // @ts-expect-error The pan handlers are internal to OrbitControls and MapControls.
    super._handleMouseDownPan(event);
    if (this.screenSpacePanning) return;
    this.panPlane.setFromNormalAndCoplanarPoint(this.object.up, this.target);
    if (this.blended()) this.groundAt(event, this._panWorldStart);
  }

  protected _handleMouseMovePan(event: PointerEvent): void {
    if (this.screenSpacePanning || !this.blended()) {
      // @ts-expect-error The pan handlers are internal to OrbitControls and MapControls.
      super._handleMouseMovePan(event);
      return;
    }
    if (!this.groundAt(event, this.panPoint)) return;
    this._panOffset.copy(this.panPoint.sub(this._panWorldStart)).negate();
    this.update();
  }

  private blended(): boolean {
    return this.object instanceof ViewCamera && this.object.blended;
  }

  private groundAt(event: PointerEvent, target: Vector3): boolean {
    const ray = projectionRay(
      this.object as ViewCamera,
      this.domElement!,
      event.clientX,
      event.clientY,
    );
    return ray.intersectPlane(this.panPlane, target) !== null;
  }
}
