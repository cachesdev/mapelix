import { MapControls } from "three/addons/controls/MapControls.js";
import { MathUtils, Quaternion, Vector3, type PerspectiveCamera } from "three/webgpu";

type HeightAt = (x: number, z: number) => number | undefined;

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
const CLEARANCE = 2.5;
/** Farthest the camera orbits from the point it looks at, in blocks. */
export const ZOOM_LIMIT = 2600;
/** The zoom limit while zooming out is unlocked. */
const UNLOCKED_ZOOM_LIMIT = 20_000;

/**
 * Map-style camera: left drag pans across the ground, right drag orbits, and the
 * wheel zooms toward the cursor. The orbit point follows the terrain, and keyboard
 * keys pan (WASD), turn (Q and E), and zoom (R and F).
 */
export class CameraRig {
  private readonly camera: PerspectiveCamera;
  private readonly controls: MapControls;
  private readonly heightAt: HeightAt;
  private readonly keys = new Set<string>();
  private readonly lastPosition = new Vector3();
  private readonly lastTarget = new Vector3();
  private flight: Flight | undefined;

  constructor(camera: PerspectiveCamera, element: HTMLElement, heightAt: HeightAt) {
    this.camera = camera;
    this.heightAt = heightAt;
    this.controls = new MapControls(camera, element);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 6;
    this.controls.maxDistance = ZOOM_LIMIT;
    this.controls.minPolarAngle = 0.04;
    this.controls.maxPolarAngle = 1.42;
    this.controls.rotateSpeed = 0.55;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener("start", () => {
      this.flight = undefined;
    });

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

  /** Places the camera `distance` blocks from a point, facing `heading` and looking down by `pitch`. */
  setView(view: CameraView): void {
    const azimuth = -view.heading;
    const pitch = MathUtils.clamp(
      view.pitch,
      Math.PI / 2 - this.controls.maxPolarAngle,
      Math.PI / 2 - this.controls.minPolarAngle,
    );
    this.flight = undefined;
    this.controls.target.set(view.x, view.y, view.z);
    this.camera.position.set(
      view.x + Math.sin(azimuth) * Math.cos(pitch) * view.distance,
      view.y + Math.sin(pitch) * view.distance,
      view.z + Math.cos(azimuth) * Math.cos(pitch) * view.distance,
    );
    this.controls.update();
  }

  /** Lets the camera zoom out past the usual limit. Locking again brings it back within it. */
  setZoomUnlocked(unlocked: boolean): void {
    this.controls.maxDistance = unlocked ? UNLOCKED_ZOOM_LIMIT : ZOOM_LIMIT;
  }

  /** Glides to a column, arcing higher for longer trips so the terrain stays readable. */
  flyTo(x: number, z: number): void {
    const fromTarget = this.controls.target.clone();
    const toTarget = new Vector3(x, this.heightAt(x, z) ?? fromTarget.y, z);
    const travel = fromTarget.distanceTo(toTarget);
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
    const offset = this.camera.position.clone().sub(this.controls.target);
    const length = MathUtils.clamp(
      offset.length() * factor,
      this.controls.minDistance,
      this.controls.maxDistance,
    );
    this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), length);
  }

  faceNorth(): void {
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
    this.followTerrain(delta);

    const moved =
      this.camera.position.distanceToSquared(this.lastPosition) > 1e-6 ||
      this.controls.target.distanceToSquared(this.lastTarget) > 1e-6;
    this.lastPosition.copy(this.camera.position);
    this.lastTarget.copy(this.controls.target);
    return moved;
  }

  dispose(): void {
    this.controls.dispose();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
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
    if (progress >= 1) this.flight = undefined;
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
    if (zoom !== 0) this.zoom(1 + zoom * 1.6 * delta);
  }

  /** Eases the orbit point onto the ground and keeps the camera above it. */
  private followTerrain(delta: number): void {
    const target = this.controls.target;
    const ground = this.heightAt(target.x, target.z);
    if (ground !== undefined && this.flight === undefined) {
      const rise = (ground - target.y) * Math.min(1, delta * 5);
      target.y += rise;
      this.camera.position.y += rise;
    }
    const below = this.heightAt(this.camera.position.x, this.camera.position.z);
    if (below !== undefined && this.camera.position.y < below + CLEARANCE) {
      this.camera.position.y = below + CLEARANCE;
    }
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return;
    this.keys.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
  };
}
