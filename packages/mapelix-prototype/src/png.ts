import { PNG } from "pngjs";

/** Decode only the expected image size, rejecting a mismatched header before allocation. */
export function decodePng(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (
    !Number.isSafeInteger(width) ||
    width < 1 ||
    !Number.isSafeInteger(height) ||
    height < 1 ||
    !Number.isSafeInteger(width * height * 4)
  )
    throw new RangeError("Expected PNG dimensions must be positive safe integers");
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 33 || signature.some((value, index) => bytes[index] !== value))
    throw new Error("Invalid PNG header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    view.getUint32(16) !== width ||
    view.getUint32(20) !== height
  )
    throw new RangeError(`PNG dimensions must match ${width} by ${height}`);
  const decoded = PNG.sync.read(Buffer.from(bytes));
  return decoded.data;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  if (rgba.byteLength !== width * height * 4) {
    throw new RangeError(`RGBA byte length does not match ${width} by ${height}`);
  }

  const png = new PNG({ width, height });
  png.data.set(rgba);
  return PNG.sync.write(png);
}
