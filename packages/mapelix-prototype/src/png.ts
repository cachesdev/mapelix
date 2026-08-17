import { PNG } from "pngjs";

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.byteLength !== width * height * 4) {
    throw new RangeError(`RGBA byte length does not match ${width} by ${height}`);
  }

  const png = new PNG({ width, height });
  png.data.set(rgba);
  return PNG.sync.write(png);
}
