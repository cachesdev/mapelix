import { Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";

import { retarget } from "./camera-anchor";

/** A camera 40 blocks from its target, looking down north-west. */
function pose(): { camera: Vector3; target: Vector3 } {
  const target = new Vector3(41, 81, 2);
  const camera = target.clone().add(new Vector3(-12, 24, 30).setLength(40));
  return { camera, target };
}

function direction(camera: Vector3, target: Vector3): Vector3 {
  return target.clone().sub(camera).normalize();
}

describe("retarget", () => {
  it("keeps a perspective camera in place and moves the pivot along its view", () => {
    const { camera, target } = pose();
    const before = camera.clone();
    const view = direction(camera, target);
    retarget(camera, target, 33, false);
    expect(camera.toArray()).toEqual(before.toArray());
    expect(camera.distanceTo(target)).toBeCloseTo(33, 9);
    expect(direction(camera, target).angleTo(view)).toBeCloseTo(0, 9);
  });

  it("keeps the orbit distance of an orthographic view, which sets its scale", () => {
    for (const reach of [12, 33, 40, 75]) {
      const { camera, target } = pose();
      const start = camera.clone();
      const view = direction(camera, target);
      retarget(camera, target, reach, true);
      expect(camera.distanceTo(target)).toBeCloseTo(40, 9);
      expect(direction(camera, target).angleTo(view)).toBeCloseTo(0, 9);
      // The pivot lands where the view ray met the terrain.
      expect(target.distanceTo(start.clone().addScaledVector(view, reach))).toBeCloseTo(0, 9);
      // The camera only slides along its view line, which an orthographic view does not show.
      const slide = camera.clone().sub(start);
      expect(slide.clone().cross(view).length()).toBeCloseTo(0, 9);
      expect(slide.dot(view)).toBeCloseTo(reach - 40, 9);
    }
  });

  it("leaves a camera standing on its pivot alone", () => {
    const camera = new Vector3(1, 2, 3);
    const target = camera.clone();
    retarget(camera, target, 10, true);
    expect(camera.toArray()).toEqual([1, 2, 3]);
    expect(target.toArray()).toEqual([1, 2, 3]);
  });
});
