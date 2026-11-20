import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { decodePng, encodePng } from "./png.js";

describe("encodePng", () => {
  it("decodes expected-size RGBA and refuses mismatched dimensions before PNG inflation", () => {
    const pixels = new Uint8Array([10, 20, 30, 128, 200, 150, 80, 0]);
    const encoded = encodePng(pixels, 2, 1);
    expect(Array.from(decodePng(encoded, 2, 1))).toEqual(Array.from(pixels));
    expect(() => decodePng(encoded, 256, 256)).toThrow("dimensions");
    expect(() => decodePng(encoded, 0, 1)).toThrow("positive safe");
    expect(() => decodePng(new Uint8Array(33), 1, 1)).toThrow("header");
  });
  it("encodes exact dimensions and pixels", () => {
    const encoded = encodePng(new Uint8Array([10, 20, 30, 255]), 1, 1);
    expect(Array.from(encoded.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const decoded = PNG.sync.read(Buffer.from(encoded));
    expect([decoded.width, decoded.height]).toEqual([1, 1]);
    expect(Array.from(decoded.data)).toEqual([10, 20, 30, 255]);
  });
});
