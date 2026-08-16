import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { encodePng } from "./png.js";

describe("encodePng", () => {
  it("encodes exact dimensions and pixels", () => {
    const encoded = encodePng(new Uint8Array([10, 20, 30, 255]), 1, 1);
    expect(Array.from(encoded.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

    const decoded = PNG.sync.read(Buffer.from(encoded));
    expect([decoded.width, decoded.height]).toEqual([1, 1]);
    expect(Array.from(decoded.data)).toEqual([10, 20, 30, 255]);
  });
});
