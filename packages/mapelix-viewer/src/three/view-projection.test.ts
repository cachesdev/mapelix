import { describe, expect, it } from "vitest";
import {
  MathUtils,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
  WebGPUCoordinateSystem,
} from "three/webgpu";
import {
  ViewCamera,
  distanceForPixelsPerBlock,
  easeProjection,
  effectiveProjection,
  pixelsPerBlock,
  projectedPixels,
  projectionRay,
} from "./view-projection";

const FOCUS = 120;

function camera(blend: number, coordinateSystem?: number): ViewCamera {
  const view = new ViewCamera(50, 1.5, 1, 4000);
  if (coordinateSystem !== undefined) view.coordinateSystem = coordinateSystem as never;
  view.position.set(10, 90, 40);
  view.lookAt(10, 10, -50);
  view.updateMatrixWorld();
  view.projectionBlend = blend;
  view.focusDistance = FOCUS;
  view.updateProjectionMatrix();
  return view;
}

/** A point `depth` blocks in front of the camera, offset sideways and up in view space. */
function inView(view: ViewCamera, depth: number, right: number, up: number): Vector3 {
  return new Vector3(right, up, -depth).applyMatrix4(view.matrixWorld);
}

const element = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
} as unknown as HTMLElement;

describe("ViewCamera", () => {
  it("keeps the perspective projection exactly at blend 0", () => {
    const view = camera(0);
    const plain = new PerspectiveCamera(50, 1.5, 1, 4000);
    plain.updateProjectionMatrix();
    expect(view.projectionMatrix.elements).toEqual(plain.projectionMatrix.elements);
    expect(view.blended).toBe(false);
  });

  it("matches an orthographic camera spanning the focus plane at blend 1", () => {
    for (const system of [undefined, WebGPUCoordinateSystem]) {
      const view = camera(1, system);
      const top = FOCUS * Math.tan(MathUtils.degToRad(25));
      const ortho = new OrthographicCamera(-top * 1.5, top * 1.5, top, -top, 1 - 4000, 4000);
      if (system !== undefined) ortho.coordinateSystem = system as never;
      ortho.updateProjectionMatrix();
      for (const [index, value] of ortho.projectionMatrix.elements.entries())
        expect(view.projectionMatrix.elements[index]).toBeCloseTo(value, 12);
    }
  });

  it("keeps the focus plane scale and the far depth while blending", () => {
    const perspective = camera(0);
    for (const blend of [0.25, 0.5, 0.9, 1]) {
      const view = camera(blend);
      const onFocus = inView(view, FOCUS, 20, -15);
      const expected = onFocus.clone().project(perspective);
      const actual = onFocus.clone().project(view);
      expect(actual.x).toBeCloseTo(expected.x, 9);
      expect(actual.y).toBeCloseTo(expected.y, 9);
      expect(inView(view, 4000, 30, 30).project(view).z).toBeCloseTo(1, 9);
    }
  });

  it("draws ground behind the camera in isometric view, never close to it while blending", () => {
    // Low tilt: the bottom of the screen shows ground that lies behind the camera.
    const iso = inView(camera(1), -300, 0, -40).project(camera(1));
    expect(iso.z).toBeGreaterThan(-1);
    expect(iso.z).toBeLessThan(1);
    for (const blend of [0.1, 0.5, 0.9]) {
      const view = camera(blend);
      // Beyond the near clip, points stay at most twice the focus scale.
      const nearClip = (blend * FOCUS) / (2 * (1 - blend));
      const clipped = new Vector3(0, 0, nearClip * 1.05).applyMatrix4(view.matrixWorld);
      expect(clipped.project(view).z).toBeLessThan(-1);
    }
  });

  it("draws farther points no smaller than perspective, and equal in isometric view", () => {
    const perspective = camera(0);
    const iso = camera(1);
    const half = camera(0.5);
    const width = (view: ViewCamera, depth: number) =>
      inView(view, depth, 1, 0).project(view).x - inView(view, depth, 0, 0).project(view).x;
    expect(width(iso, 900)).toBeCloseTo(width(iso, 30), 9);
    expect(width(half, 900)).toBeGreaterThan(width(perspective, 900));
    expect(width(half, 900)).toBeLessThan(width(iso, 900));
  });
});

describe("projectedPixels", () => {
  it("matches the blended camera's projection", () => {
    const scale = 400 / (2 * Math.tan(MathUtils.degToRad(25)));
    for (const blend of [0, 0.3, 1]) {
      const view = camera(blend);
      for (const depth of [5, FOCUS, 2000]) {
        const span =
          ((inView(view, depth, 0, 2).project(view).y - inView(view, depth, 0, 0).project(view).y) *
            400) /
          2;
        expect(projectedPixels(2, depth, scale, blend, FOCUS)).toBeCloseTo(span, 6);
      }
    }
  });
});

describe("projectionRay", () => {
  it("matches the camera-origin ray in perspective", () => {
    const view = camera(0);
    const ray = projectionRay(view, element, 450, 100);
    expect(ray.origin.toArray()).toEqual(view.position.toArray());
  });

  it("casts parallel rays from the near plane that hit what is drawn there", () => {
    for (const system of [undefined, WebGPUCoordinateSystem]) {
      const view = camera(1, system);
      const forward = view.getWorldDirection(new Vector3());
      const a = projectionRay(view, element, 30, 20);
      const b = projectionRay(view, element, 570, 390);
      expect(a.direction.dot(forward)).toBeCloseTo(1, 9);
      expect(b.direction.dot(forward)).toBeCloseTo(1, 9);
      expect(a.origin.distanceTo(b.origin)).toBeGreaterThan(50);
      // The point the ray reaches at the focus distance projects back under the pointer.
      const point = a.at(FOCUS, new Vector3()).project(view);
      expect(((point.x + 1) / 2) * 600).toBeCloseTo(30, 6);
      expect(((1 - point.y) / 2) * 400).toBeCloseTo(20, 6);
    }
  });

  it("follows the blended projection under the pointer", () => {
    const view = camera(0.5);
    const ray = projectionRay(view, element, 120, 300);
    for (const distance of [10, 400, 1500]) {
      const point = ray.at(distance, new Vector3()).project(view);
      expect(((point.x + 1) / 2) * 600).toBeCloseTo(120, 6);
      expect(((1 - point.y) / 2) * 400).toBeCloseTo(300, 6);
    }
  });
});

describe("scale and rules", () => {
  it("converts between orbit distance and pixels per block", () => {
    expect(pixelsPerBlock(160, 50, 768)).toBeCloseTo(5.1468, 3);
    expect(distanceForPixelsPerBlock(pixelsPerBlock(321, 50, 900), 50, 900)).toBeCloseTo(321, 9);
  });

  it("eases from 0 to 1", () => {
    expect(easeProjection(-1)).toBe(0);
    expect(easeProjection(0.5)).toBe(0.5);
    expect(easeProjection(2)).toBe(1);
  });

  it("applies automatic perspective with hysteresis", () => {
    const rules = { abovePixelsPerBlock: 16, belowPitch: MathUtils.degToRad(20) };
    const at = (pixels: number, degrees: number) => ({
      pixelsPerBlock: pixels,
      pitch: MathUtils.degToRad(degrees),
    });
    expect(effectiveProjection("perspective", "perspective", at(1, 60), rules)).toBe("perspective");
    expect(effectiveProjection("isometric", "isometric", at(40, 5), undefined)).toBe("isometric");
    expect(effectiveProjection("isometric", "isometric", at(8, 45), rules)).toBe("isometric");
    expect(effectiveProjection("isometric", "isometric", at(17, 45), rules)).toBe("perspective");
    expect(effectiveProjection("isometric", "isometric", at(8, 19), rules)).toBe("perspective");
    // Just past a threshold, a rule that applies keeps applying.
    expect(effectiveProjection("isometric", "perspective", at(15.5, 45), rules)).toBe(
      "perspective",
    );
    expect(effectiveProjection("isometric", "perspective", at(14, 45), rules)).toBe("isometric");
    expect(effectiveProjection("isometric", "perspective", at(8, 21), rules)).toBe("perspective");
    expect(effectiveProjection("isometric", "perspective", at(8, 22), rules)).toBe("isometric");
  });
});
