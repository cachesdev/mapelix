import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  makePng,
  makeTga,
  makeZip,
  packFiles,
  writePackFolder,
  type ZipFileSpec,
} from "../../test/synthetic-pack.js";
import { decodeTga, parsePackJson } from "./pack-image.js";
import { DEFAULT_PACK_LIMITS, ResourcePackError, packPath } from "./pack-limits.js";
import { openResourcePackStack, packFingerprint } from "./resource-pack.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mapelix-packs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const red = makePng(16, [255, 0, 0, 255]);
const blue = makePng(16, [0, 0, 255, 255]);
const base = {
  name: "Base",
  uuid: "00000000-0000-4000-8000-0000000000b1",
  terrain: {
    stone: { textures: "textures/blocks/stone" },
    grass_side: { textures: [{ path: "textures/blocks/grass_side", overlay_color: "#79c05a" }] },
    wool: { textures: ["textures/blocks/wool_white", "textures/blocks/wool_orange"] },
  },
  blocks: {
    stone: { textures: "stone" },
    "minecraft:grass": { textures: { up: "grass_top", down: "dirt", side: "grass_side" } },
  },
  flipbooks: [
    { flipbook_texture: "textures/blocks/water", atlas_tile: "water", ticks_per_frame: 2 },
  ],
  images: {
    "textures/blocks/stone.png": red,
    "textures/blocks/grass_side.tga": makeTga(2, 1, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    "textures/blocks/wool_white.png": red,
  },
};

async function file(name: string, specs: readonly ZipFileSpec[]): Promise<string> {
  const path = join(root, name);
  await writeFile(path, makeZip(specs));
  return path;
}

describe("resource pack stack", () => {
  it("reads a folder, a zip and an .mcpack, with the pack at the root or one level down", async () => {
    const folder = join(root, "folder");
    await writePackFolder(folder, packFiles(base));
    const zip = await file("pack.zip", packFiles(base));
    const nested = await file(
      "nested.mcpack",
      packFiles(base).map((spec) => ({ ...spec, name: `resource_pack/${spec.name}` })),
    );
    for (const source of [folder, zip, nested]) {
      const stack = await openResourcePackStack([source]);
      expect(stack.packs[0]!.info).toEqual({
        name: "Base",
        version: "1.0.0",
        uuid: "00000000-0000-4000-8000-0000000000b1",
      });
      expect(stack.blockTextures("minecraft:grass")).toEqual({
        up: "grass_top",
        down: "dirt",
        north: "grass_side",
        south: "grass_side",
        east: "grass_side",
        west: "grass_side",
      });
      expect(stack.blockTextures("stone")?.west).toBe("stone");
      expect(stack.terrainEntry("grass_side")).toEqual({
        textures: [{ path: "textures/blocks/grass_side", color: 0x79c05a, overlay: true }],
      });
      expect(stack.terrainEntry("wool")?.textures).toHaveLength(2);
      expect(stack.flipbook("water")).toEqual({
        path: "textures/blocks/water",
        ticksPerFrame: 2,
        blendFrames: true,
      });
      expect((await stack.readImage("textures/blocks/stone"))?.rgba.slice(0, 4)).toEqual(
        new Uint8Array([255, 0, 0, 255]),
      );
      expect((await stack.readImage("textures/blocks/grass_side"))?.rgba).toEqual(
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      );
      expect(await stack.readImage("textures/blocks/wool_orange")).toBeUndefined();
    }
    // The same content gives the same fingerprint, whatever holds it.
    const prints = await Promise.all(
      [folder, zip].map(async (source) => (await openResourcePackStack([source])).fingerprint),
    );
    expect(prints[0]).toMatch(/^[0-9a-f]{20}$/);
  });

  it("takes from each pack what the packs above it lack, and fingerprints the whole stack", async () => {
    const top = await file(
      "top.zip",
      packFiles({
        name: "Top",
        uuid: "00000000-0000-4000-8000-0000000000a1",
        version: [2, 3, 4],
        terrain: { stone: { textures: "textures/blocks/stone_top_pack" } },
        images: {
          "textures/blocks/stone_top_pack.png": blue,
          // Only an image: the path comes from the base pack's terrain_texture.json.
          "textures/blocks/wool_white.png": blue,
        },
      }),
    );
    const bottom = await file("base.zip", packFiles(base));
    const stack = await openResourcePackStack([top, bottom]);
    expect(stack.packs.map((pack) => pack.info.name)).toEqual(["Top", "Base"]);
    expect(stack.packs[0]!.info.version).toBe("2.3.4");
    expect(stack.terrainEntry("stone")?.textures[0]?.path).toBe("textures/blocks/stone_top_pack");
    expect(stack.terrainEntry("wool")?.textures[0]?.path).toBe("textures/blocks/wool_white");
    expect((await stack.readImage("textures/blocks/wool_white"))?.rgba[2]).toBe(255);
    expect(stack.blockTextures("stone")).toBeDefined();

    const alone = await openResourcePackStack([bottom]);
    const reversed = await openResourcePackStack([bottom, top]);
    expect(new Set([stack.fingerprint, alone.fingerprint, reversed.fingerprint]).size).toBe(3);
    expect((await openResourcePackStack([top, bottom])).fingerprint).toBe(stack.fingerprint);

    const changed = await file(
      "base2.zip",
      packFiles({ ...base, images: { ...base.images, "textures/blocks/stone.png": blue } }),
    );
    expect((await openResourcePackStack([top, changed])).fingerprint).toBe(stack.fingerprint);
    expect((await openResourcePackStack([changed])).fingerprint).not.toBe(alone.fingerprint);
  });

  it("explains what is wrong with an invalid pack", async () => {
    const notZip = join(root, "not.zip");
    await writeFile(notZip, "hello");
    const empty = join(root, "empty");
    await mkdir(empty);
    const behavior = await file("behavior.zip", [
      { name: "manifest.json", data: JSON.stringify({ header: {}, modules: [{ type: "data" }] }) },
    ]);
    const badManifest = await file("bad.zip", [
      {
        name: "manifest.json",
        data: JSON.stringify({ header: { name: "x" }, modules: [{ type: "resources" }] }),
      },
    ]);
    const badJson = await file("json.zip", [
      ...packFiles(base).filter((spec) => spec.name !== "blocks.json"),
      { name: "blocks.json", data: "{ nope" },
    ]);
    const two = await file("two.zip", [
      ...packFiles(base).map((spec) => ({ ...spec, name: `a/${spec.name}` })),
      ...packFiles(base).map((spec) => ({ ...spec, name: `b/${spec.name}` })),
    ]);
    const cases: [string, RegExp][] = [
      [join(root, "missing"), /is missing/],
      [notZip, /not a zip archive/],
      [empty, /no resource pack/],
      [behavior, /no resource pack/],
      [badManifest, /no header name, uuid or version/],
      [badJson, /blocks\.json\): is not valid JSON/],
      [two, /several resource packs/],
    ];
    for (const [source, message] of cases) {
      const error = await openResourcePackStack([source]).catch((caught: unknown) => caught);
      expect(error, source).toBeInstanceOf(ResourcePackError);
      expect((error as Error).message, source).toMatch(message);
    }
    await expect(openResourcePackStack([])).rejects.toThrow(RangeError);
  });

  it("refuses archives that are damaged or built to escape or exhaust", async () => {
    const pack = packFiles(base);
    const bomb = new Uint8Array(4 * 1024 * 1024);
    const cases: [ZipFileSpec[], RegExp, Partial<typeof DEFAULT_PACK_LIMITS>?][] = [
      [[...pack, { name: "../escape.png", data: red }], /unsafe entry name/],
      [[...pack, { name: "/etc/passwd", data: "x" }], /unsafe entry name/],
      [[...pack, { name: "C:/x.png", data: "x" }], /unsafe entry name/],
      [[...pack, { name: "textures\\x.png", data: "x" }], /unsafe entry name/],
      [[...pack, { name: "a//b.png", data: "x" }], /unsafe entry name/],
      [[...pack, { name: "manifest.json", data: "{}" }], /appears twice/],
      [[...pack, { name: "sounds/bomb.bin", data: bomb }], /compresses more than 400 to 1/],
      [[...pack, { name: "x.bin", data: "x", flags: 1 }], /is encrypted/],
      [[...pack, { name: "x.bin", data: "x", declaredSize: 0xffff_ffff }], /ZIP64/],
      [pack, /more than 3 entries/, { maxEntries: 3 }],
      [pack, /holds more than 100 bytes/, { maxTotalBytes: 100 }],
    ];
    for (const [specs, message, limits] of cases) {
      const path = await file("case.zip", specs);
      await expect(openResourcePackStack([path], limits), String(message)).rejects.toThrow(message);
    }
    expect(
      (await openResourcePackStack([await file("ok.zip", pack)], { maxArchiveBytes: 10 }).catch(
        (error: unknown) => error,
      )) as Error,
    ).toBeInstanceOf(ResourcePackError);
  });

  it("refuses a file whose content lies about its size or checksum when it is read", async () => {
    const lies: [ZipFileSpec, RegExp][] = [
      [{ name: "textures/blocks/stone.png", data: red, declaredSize: 10 }, /declared size/],
      [
        { name: "textures/blocks/stone.png", data: red, declaredSize: red.byteLength + 50 },
        /declared size/,
      ],
      [{ name: "textures/blocks/stone.png", data: red, crc: 1234 }, /CRC-32/],
      [
        { name: "textures/blocks/stone.png", data: red, method: 0, declaredSize: 3 },
        /inconsistent sizes/,
      ],
      [{ name: "textures/blocks/stone.png", data: red, method: 12 }, /compression method 12/],
    ];
    for (const [spec, message] of lies) {
      const others = packFiles(base).filter((file) => file.name !== spec.name);
      const stack = await openResourcePackStack([await file("lie.zip", [...others, spec])]);
      await expect(stack.readImage("textures/blocks/stone"), String(message)).rejects.toThrow(
        message,
      );
    }
    const noise = new Uint8Array(128 * 128 * 4).map((_, index) => (index * 2_654_435_761) >>> 24);
    const big = await openResourcePackStack(
      [
        await file(
          "big.zip",
          packFiles({ ...base, images: { "textures/blocks/stone.tga": makeTga(128, 128, noise) } }),
        ),
      ],
      { maxFileBytes: 20_000 },
    );
    await expect(big.readImage("textures/blocks/stone")).rejects.toThrow(/larger than 20000 bytes/);
  });

  it("refuses damaged or oversized images with the pack and file named", async () => {
    const huge = new Uint8Array(red);
    new DataView(huge.buffer).setUint32(16, 100_000);
    const truncated = red.slice(0, 40);
    const images: [Uint8Array, string, RegExp][] = [
      [huge, "png", /wider or taller/],
      [truncated, "png", /damaged PNG/],
      [new TextEncoder().encode("not an image at all, really"), "png", /not a PNG/],
      [new Uint8Array(10), "tga", /truncated/],
    ];
    for (const [bytes, extension, message] of images) {
      const stack = await openResourcePackStack([
        await file(
          "image.zip",
          packFiles({ ...base, images: { [`textures/blocks/stone.${extension}`]: bytes } }),
        ),
      ]);
      const error = await stack
        .readImage("textures/blocks/stone")
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ResourcePackError);
      expect((error as Error).message).toMatch(`image.zip (textures/blocks/stone.${extension})`);
      expect((error as Error).message).toMatch(message);
    }
  });

  it("refuses a folder pack holding a link, and a pack that is a link", async () => {
    const folder = join(root, "linked");
    await writePackFolder(folder, packFiles(base));
    const outside = join(root, "secret");
    await mkdir(outside);
    await writeFile(join(outside, "stone_secret.png"), blue);
    try {
      await symlink(outside, join(folder, "textures", "outside"), "junction");
      await symlink(outside, join(root, "alias"), "junction");
    } catch {
      return; // This system does not let tests create links.
    }
    await expect(openResourcePackStack([folder])).rejects.toThrow(
      /linked \(textures\/outside\): holds a link/,
    );
    await expect(openResourcePackStack([join(root, "alias")])).rejects.toThrow(/is a link/);
  });

  it("opens a stack folder in the order of mapelix-stack.json and checks what it lists", async () => {
    const stackFolder = join(root, "stack");
    await mkdir(join(stackFolder, "packs"), { recursive: true });
    const top = packFiles({
      name: "Top",
      uuid: "00000000-0000-4000-8000-0000000000a1",
      version: [2, 0, 0],
      terrain: { stone: { textures: "textures/blocks/stone_top" } },
      images: { "textures/blocks/stone_top.png": blue },
    });
    await writePackFolder(join(stackFolder, "packs", "top"), top);
    await writeFile(join(stackFolder, "base.mcpack"), makeZip(packFiles(base)));
    const write = (packs: unknown[], extra: Record<string, unknown> = {}): Promise<void> =>
      writeFile(
        join(stackFolder, "mapelix-stack.json"),
        JSON.stringify({ format: "mapelix-texture-stack", version: 1, packs, ...extra }),
      );
    const topEntry = {
      path: "packs/top",
      uuid: "00000000-0000-4000-8000-0000000000A1",
      version: "2.0.0",
    };
    const baseEntry = { path: "base.mcpack", uuid: base.uuid, version: "1.0.0" };
    await write([topEntry, baseEntry]);
    const stack = await openResourcePackStack({ stack: stackFolder });
    expect(stack.packs.map((pack) => pack.info.name)).toEqual(["Top", "Base"]);
    expect(stack.terrainEntry("stone")?.textures[0]?.path).toBe("textures/blocks/stone_top");
    expect(stack.fingerprint).toBe(
      (
        await openResourcePackStack([
          join(stackFolder, "packs", "top"),
          join(stackFolder, "base.mcpack"),
        ])
      ).fingerprint,
    );

    // A pinned fingerprint must match the pack.
    const pinned = await packFingerprint(stack.packs[1]!);
    expect(pinned).toMatch(/^[0-9a-f]{20}$/);
    await write([topEntry, { ...baseEntry, fingerprint: pinned }]);
    await expect(openResourcePackStack({ stack: stackFolder })).resolves.toBeDefined();

    const cases: [unknown[], RegExp, Record<string, unknown>?][] = [
      [[topEntry, { ...baseEntry, fingerprint: "0".repeat(20) }], /pins 0{20}/],
      [[{ ...topEntry, version: "2.0.1" }], /lists 00000000-0000-4000-8000-0000000000a1 2\.0\.1/],
      [[{ ...topEntry, path: "../outside" }], /path is unsafe/],
      [[{ ...topEntry, path: "/etc" }], /path is unsafe/],
      [[{ ...topEntry, path: "packs\\top" }], /path is unsafe/],
      [[{ ...topEntry, path: "missing" }], /missing is missing/],
      [[topEntry, topEntry], /same pack twice/],
      [[{ ...topEntry, uuid: "nope" }], /uuid is not a UUID/],
      [[], /lists no packs/],
      [[topEntry], /reads 1/, { version: 2 }],
      [[topEntry], /format/, { format: "other" }],
    ];
    for (const [packs, message, extra] of cases) {
      await write(packs, extra);
      await expect(openResourcePackStack({ stack: stackFolder }), String(message)).rejects.toThrow(
        message,
      );
    }
    await write(Array.from({ length: 3 }, () => topEntry));
    await expect(openResourcePackStack({ stack: stackFolder }, { maxPacks: 2 })).rejects.toThrow(
      /more than 2 packs/,
    );
    await writeFile(join(stackFolder, "mapelix-stack.json"), "{ nope");
    await expect(openResourcePackStack({ stack: stackFolder })).rejects.toThrow(/not valid JSON/);
    await expect(openResourcePackStack({ stack: join(root, "none") })).rejects.toThrow(
      /is missing/,
    );
    // The whole stack is bounded too.
    await write([topEntry, baseEntry]);
    await expect(
      openResourcePackStack({ stack: stackFolder }, { maxStackEntries: 6 }),
    ).rejects.toThrow(/over 6 files/);
  });
});

describe("pack paths", () => {
  it("normalizes safe paths and refuses the rest", () => {
    expect(packPath("textures/blocks/a.png")).toBe("textures/blocks/a.png");
    expect(packPath("textures/blocks/")).toBeUndefined();
    for (const bad of [
      "",
      "/a",
      "a/../b",
      "./a",
      "a\\b",
      "C:x",
      "a\0b",
      "a//b",
      "x".repeat(2000),
    ]) {
      expect(() => packPath(bad), bad).toThrow();
    }
  });
});

describe("TGA images", () => {
  const limits = DEFAULT_PACK_LIMITS;
  const header = (
    type: number,
    width: number,
    height: number,
    depth: number,
    descriptor: number,
  ) => {
    const out = new Uint8Array(18);
    out[2] = type;
    out[12] = width;
    out[14] = height;
    out[16] = depth;
    out[17] = descriptor;
    return out;
  };
  const join2 = (...parts: Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  };

  it("decodes raw and run-length 24-bit, 32-bit and gray images in either row order", () => {
    // 2×2, bottom-left origin, BGR: bottom row first.
    const raw24 = join2(
      header(2, 2, 2, 24, 0),
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    );
    expect(Array.from(decodeTga(raw24, limits).rgba)).toEqual([
      9, 8, 7, 255, 12, 11, 10, 255, 3, 2, 1, 255, 6, 5, 4, 255,
    ]);
    // Run of 3 then a raw packet of 1, top-left origin, 32 bits with alpha.
    const rle32 = join2(
      header(10, 2, 2, 32, 0x28),
      new Uint8Array([0x82, 10, 20, 30, 40, 0x00, 1, 2, 3, 4]),
    );
    expect(Array.from(decodeTga(rle32, limits).rgba)).toEqual([
      30, 20, 10, 40, 30, 20, 10, 40, 30, 20, 10, 40, 3, 2, 1, 4,
    ]);
    const gray = join2(header(3, 1, 1, 8, 0x20), new Uint8Array([77]));
    expect(Array.from(decodeTga(gray, limits).rgba)).toEqual([77, 77, 77, 255]);
    // Thirty-two bits without declared alpha bits stay opaque.
    const noAlpha = join2(header(2, 1, 1, 32, 0x20), new Uint8Array([1, 2, 3, 0]));
    expect(decodeTga(noAlpha, limits).rgba[3]).toBe(255);
  });

  it("refuses runs that overflow, truncated data and unsupported layouts", () => {
    const cases: [Uint8Array, RegExp][] = [
      [join2(header(10, 2, 2, 24, 0x20), new Uint8Array([0xff, 1, 2, 3])), /overflows/],
      [join2(header(10, 2, 2, 24, 0x20), new Uint8Array([0x83, 1, 2])), /truncated/],
      [join2(header(10, 2, 2, 24, 0x20), new Uint8Array([0x81, 1, 2, 3])), /truncated/],
      [join2(header(2, 4, 4, 32, 0x20), new Uint8Array(10)), /truncated/],
      [join2(header(1, 2, 2, 8, 0x20), new Uint8Array(4)), /type 1/],
      [join2(header(2, 2, 2, 16, 0x20), new Uint8Array(8)), /depth 16/],
      [join2(header(2, 0, 2, 24, 0x20), new Uint8Array(8)), /no pixels/],
      [new Uint8Array([0, 1, 2, ...new Uint8Array(15)]), /color map/],
    ];
    for (const [bytes, message] of cases) expect(() => decodeTga(bytes, limits)).toThrow(message);
    expect(() =>
      decodeTga(join2(header(2, 200, 200, 24, 0x20), new Uint8Array(120_000)), {
        maxImagePixels: 1000,
        maxImageSide: 8192,
      }),
    ).toThrow(/more than 1000 pixels/);
  });
});

describe("pack JSON", () => {
  it("accepts comments, a byte-order mark and trailing commas, but not inside strings", () => {
    const text = '\ufeff{\n // note\n "a": "x // not a comment, ]", /* block */ "b": [1, 2,],\n}';
    expect(parsePackJson(new TextEncoder().encode(text))).toEqual({
      a: "x // not a comment, ]",
      b: [1, 2],
    });
  });
});
