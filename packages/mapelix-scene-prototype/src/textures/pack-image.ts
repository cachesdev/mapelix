import { decodePng } from "@mapelix/prototype/png";

/** An 8-bit RGBA image, rows from the top. */
export interface PackImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export interface ImageLimits {
  readonly maxImagePixels: number;
  readonly maxImageSide: number;
}

/** Image extensions a pack may use, in the order a lookup tries them. */
export const IMAGE_EXTENSIONS = [".png", ".tga"] as const;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Decodes a PNG or TGA texture, checking its size against `limits` before any allocation. */
export function decodePackImage(bytes: Uint8Array, path: string, limits: ImageLimits): PackImage {
  if (path.endsWith(".png")) return decodePackPng(bytes, limits);
  if (path.endsWith(".tga")) return decodeTga(bytes, limits);
  throw new Error("only PNG and TGA images are read");
}

/** Reads a PNG or TGA texture's size from its header alone, checked against `limits`. */
export function packImageSize(
  bytes: Uint8Array,
  path: string,
  limits: ImageLimits,
): { readonly width: number; readonly height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width: number;
  let height: number;
  if (path.endsWith(".png")) {
    if (bytes.byteLength < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
      throw new Error("not a PNG image");
    }
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (path.endsWith(".tga")) {
    if (bytes.byteLength < 18) throw new Error("TGA image is truncated");
    width = view.getUint16(12, true);
    height = view.getUint16(14, true);
  } else {
    throw new Error("only PNG and TGA images are read");
  }
  checkSize(width, height, limits);
  return { width, height };
}

function checkSize(width: number, height: number, limits: ImageLimits): void {
  if (width < 1 || height < 1) throw new Error("image has no pixels");
  if (width > limits.maxImageSide || height > limits.maxImageSide) {
    throw new Error(`image is wider or taller than ${limits.maxImageSide} pixels`);
  }
  if (width * height > limits.maxImagePixels) {
    throw new Error(`image has more than ${limits.maxImagePixels} pixels`);
  }
}

function decodePackPng(bytes: Uint8Array, limits: ImageLimits): PackImage {
  if (bytes.byteLength < 33 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw new Error("not a PNG image");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  checkSize(width, height, limits);
  let rgba: Uint8Array;
  try {
    rgba = decodePng(bytes, width, height);
  } catch (error) {
    throw new Error(`damaged PNG image: ${(error as Error).message}`);
  }
  if (rgba.byteLength !== width * height * 4) throw new Error("damaged PNG image");
  return { width, height, rgba: new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) };
}

/**
 * Decodes an uncompressed or run-length encoded true-color (24 or 32 bits) or grayscale
 * (8 bits) TGA image without a color map.
 */
export function decodeTga(bytes: Uint8Array, limits: ImageLimits): PackImage {
  if (bytes.byteLength < 18) throw new Error("TGA image is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const idLength = bytes[0]!;
  const colorMapType = bytes[1]!;
  const imageType = bytes[2]!;
  const width = view.getUint16(12, true);
  const height = view.getUint16(14, true);
  const depth = bytes[16]!;
  const descriptor = bytes[17]!;
  if (colorMapType !== 0) throw new Error("TGA images with a color map are not supported");
  const gray = imageType === 3 || imageType === 11;
  const rle = imageType === 10 || imageType === 11;
  if (!gray && imageType !== 2 && imageType !== 10) {
    throw new Error(`TGA image type ${imageType} is not supported`);
  }
  const channels = depth / 8;
  if (gray ? depth !== 8 : depth !== 24 && depth !== 32) {
    throw new Error(`TGA depth ${depth} is not supported`);
  }
  checkSize(width, height, limits);

  const pixels = width * height;
  const rgba = new Uint8Array(pixels * 4);
  let input = 18 + idLength;
  const put = (pixel: number, from: number): void => {
    const out = pixel * 4;
    if (gray) {
      const value = bytes[from]!;
      rgba[out] = value;
      rgba[out + 1] = value;
      rgba[out + 2] = value;
      rgba[out + 3] = 255;
    } else {
      rgba[out] = bytes[from + 2]!;
      rgba[out + 1] = bytes[from + 1]!;
      rgba[out + 2] = bytes[from]!;
      rgba[out + 3] = channels === 4 ? bytes[from + 3]! : 255;
    }
  };
  if (!rle) {
    if (input + pixels * channels > bytes.byteLength) throw new Error("TGA image is truncated");
    for (let pixel = 0; pixel < pixels; pixel++) put(pixel, input + pixel * channels);
  } else {
    let pixel = 0;
    while (pixel < pixels) {
      if (input >= bytes.byteLength) throw new Error("TGA image is truncated");
      const header = bytes[input++]!;
      const count = (header & 0x7f) + 1;
      if (pixel + count > pixels) throw new Error("TGA run overflows the image");
      if ((header & 0x80) !== 0) {
        if (input + channels > bytes.byteLength) throw new Error("TGA image is truncated");
        for (let index = 0; index < count; index++) put(pixel + index, input);
        input += channels;
      } else {
        if (input + count * channels > bytes.byteLength) throw new Error("TGA image is truncated");
        for (let index = 0; index < count; index++) put(pixel + index, input + index * channels);
        input += count * channels;
      }
      pixel += count;
    }
  }

  // Alpha bits declared as zero mean the fourth channel carries no alpha.
  if (channels === 4 && (descriptor & 0x0f) === 0) {
    for (let out = 3; out < rgba.length; out += 4) rgba[out] = 255;
  }
  const fromRight = (descriptor & 0x10) !== 0;
  const fromTop = (descriptor & 0x20) !== 0;
  if (!fromTop || fromRight) reorient(rgba, width, height, !fromTop, fromRight);
  return { width, height, rgba };
}

function reorient(
  rgba: Uint8Array,
  width: number,
  height: number,
  flipRows: boolean,
  flipColumns: boolean,
): void {
  const source = rgba.slice();
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const from = new Uint32Array(source.buffer, 0, width * height);
  for (let y = 0; y < height; y++) {
    const sourceRow = flipRows ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      words[y * width + x] = from[sourceRow * width + (flipColumns ? width - 1 - x : x)]!;
    }
  }
}

/** Parses pack JSON, which may hold `//` and block comments and a byte-order mark. */
export function parsePackJson(bytes: Uint8Array): unknown {
  let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index++;
      while (index < text.length && text[index] !== '"') index += text[index] === "\\" ? 2 : 1;
      out += text.slice(start, ++index);
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index++;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      // Bedrock tolerates trailing commas.
      let next = index + 1;
      while (char === "," && next < text.length && /\s/.test(text[next]!)) next++;
      if (char !== "," || (text[next] !== "}" && text[next] !== "]")) out += char;
      index++;
    }
  }
  return JSON.parse(out);
}
