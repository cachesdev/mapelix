import { describe, expect, it } from "vitest";
import { HeldKeys, keyboardReach, keyboardSpeed } from "./camera-input";

describe("camera keyboard safety", () => {
  it("expires a missing release after 600 ms", () => {
    const keys = new HeldKeys();
    keys.add("KeyW", 100);
    keys.expire(699);
    expect(keys.has("KeyW")).toBe(true);
    keys.expire(700);
    expect(keys.size).toBe(0);
  });
  it("renews each physical key independently on repeat events", () => {
    const keys = new HeldKeys();
    keys.add("KeyW", 0);
    keys.add("KeyD", 0);
    keys.add("KeyW", 450);
    keys.expire(650);
    expect(keys.has("KeyW")).toBe(true);
    expect(keys.has("KeyD")).toBe(false);
    keys.expire(1050);
    expect(keys.size).toBe(0);
  });
  it("supports immediate release and focus-loss cleanup", () => {
    const keys = new HeldKeys();
    keys.add("Space", 0);
    keys.delete("Space");
    expect(keys.size).toBe(0);
    keys.add("KeyC", 0);
    keys.clear();
    expect(keys.size).toBe(0);
  });
  it("bounds translation at extreme zoom in both modes", () => {
    expect(keyboardSpeed(6, false)).toBe(24);
    expect(keyboardSpeed(140, false)).toBeCloseTo(154);
    expect(keyboardSpeed(2600, false)).toBe(160);
    expect(keyboardSpeed(20_000, false)).toBe(160);
    expect(keyboardSpeed(96, true)).toBe(32);
  });
  it("paces moves by the orbit distance, or the height above the ground when that is more", () => {
    expect(keyboardReach(80, 100, 90)).toBe(80);
    // A pivot on a peak close to the camera, far above the ground below it.
    expect(keyboardReach(20, 300, 64)).toBe(236);
    // Below the surface height, in a cave or under a roof.
    expect(keyboardReach(80, -20, 70)).toBe(80);
    expect(keyboardReach(12, 200, undefined)).toBe(12);
  });
});
