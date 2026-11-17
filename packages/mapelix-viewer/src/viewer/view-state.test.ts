import { describe, expect, it } from "vitest";
import {
  cameraDistance,
  cameraOverMap,
  checkThresholds,
  DEFAULT_THRESHOLDS,
  restingMode,
  shortestHeading,
  tiltPitch,
  TOP_DOWN_PITCH,
} from "./view-state.js";

describe("view switch thresholds", () => {
  it("switches to 3D above 5 and back to the map below 2 by default", () => {
    expect(restingMode("2d", 5, DEFAULT_THRESHOLDS)).toBe("2d");
    expect(restingMode("2d", 5.01, DEFAULT_THRESHOLDS)).toBe("3d");
    expect(restingMode("3d", 4, DEFAULT_THRESHOLDS)).toBe("3d");
    expect(restingMode("3d", 2, DEFAULT_THRESHOLDS)).toBe("3d");
    expect(restingMode("3d", 1.99, DEFAULT_THRESHOLDS)).toBe("2d");
  });

  it("keeps the current mode anywhere in the margin between the thresholds", () => {
    for (let scale = 2; scale <= 5; scale += 0.05) {
      expect(restingMode("2d", scale, DEFAULT_THRESHOLDS)).toBe("2d");
      expect(restingMode("3d", scale, DEFAULT_THRESHOLDS)).toBe("3d");
    }
  });

  it("never flips back on a mode it has just switched to", () => {
    for (let scale = 0.1; scale < 40; scale *= 1.07) {
      const after = restingMode("2d", scale, DEFAULT_THRESHOLDS);
      expect(restingMode(after, scale, DEFAULT_THRESHOLDS)).toBe(after);
    }
  });

  it("accepts other thresholds and refuses a missing margin", () => {
    const custom = checkThresholds({ toWorld: 8, toMap: 2 });
    expect(restingMode("2d", 6, custom)).toBe("2d");
    expect(restingMode("3d", 3, custom)).toBe("3d");
    expect(() => checkThresholds({ toWorld: 4, toMap: 4 })).toThrow(RangeError);
    expect(() => checkThresholds({ toWorld: 5, toMap: 0 })).toThrow(RangeError);
    expect(() => checkThresholds({ toWorld: Number.NaN, toMap: 1 })).toThrow(RangeError);
  });
});

describe("shared view", () => {
  it("places the camera so the focus plane keeps the map scale", () => {
    for (const height of [812, 800, 1080])
      for (const scale of [0.5, 4, 5, 16]) {
        const distance = cameraDistance(scale, height);
        const back = height / (2 * distance * Math.tan((25 * Math.PI) / 180));
        expect(back).toBeCloseTo(scale, 9);
      }
  });

  it("puts the camera over the map center, north up, looking down", () => {
    const camera = cameraOverMap({ x: -312.5, z: 48.25, pixelsPerBlock: 6 }, 812);
    expect(camera).toMatchObject({ x: -312.5, z: 48.25, heading: 0, pitch: TOP_DOWN_PITCH });
  });

  it("limits tilts to the camera range", () => {
    expect(tiltPitch(60)).toBeCloseTo(Math.PI / 3, 12);
    expect(tiltPitch(90)).toBe(TOP_DOWN_PITCH);
    expect(tiltPitch(0)).toBeCloseTo(Math.PI / 2 - 1.42, 12);
    expect(() => tiltPitch(Number.NaN)).toThrow(RangeError);
  });

  it("turns back to north the short way", () => {
    expect(shortestHeading(0)).toBe(0);
    expect(shortestHeading(Math.PI * 1.5)).toBeCloseTo(-Math.PI / 2, 12);
    expect(shortestHeading(-Math.PI * 3.25)).toBeCloseTo(Math.PI * 0.75, 12);
    expect(shortestHeading(Math.PI)).toBe(Math.PI);
  });
});
