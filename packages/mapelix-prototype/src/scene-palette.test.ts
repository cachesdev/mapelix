import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const generator = fileURLToPath(new URL("../scripts/generate-scene-palette.mjs", import.meta.url));

describe("offline scene palette generation", () => {
  let directory: string;
  let output: string;
  let report: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mapelix-palette-generator-"));
    output = join(directory, "palette.ts");
    report = join(directory, "coverage.json");
    await mkdir(join(directory, "resource_pack/textures/blocks"), { recursive: true });
    await mkdir(join(directory, "metadata/vanilladata_modules"), { recursive: true });
    const blocks = {
      fixture_alpha: { textures: "alpha" },
      fixture_faces: {
        textures: {
          up: "red",
          down: "blue",
          north: "red",
          south: "green",
          east: "blue",
          west: "green",
        },
      },
      fixture_missing: { textures: "missing" },
      fixture_missing_faces: {
        textures: {
          up: "red",
          down: "blue",
          north: "missing_north",
          south: "missing_south",
          east: "red",
          west: "green",
        },
      },
      fixture_transparent: { textures: "transparent" },
      fixture_tga: { textures: "tga" },
      fixture_tga_rle: { textures: "tga_rle" },
      bed: { textures: "green" },
    };
    const textureData = Object.fromEntries(
      [
        "alpha",
        "red",
        "green",
        "blue",
        "transparent",
        "missing_north",
        "missing_south",
        "tga",
        "tga_rle",
      ].map((name) => [name, { textures: `textures/blocks/${name}` }]),
    );
    textureData.bed_bottom = { textures: "textures/blocks/green" };
    await writeFile(join(directory, "resource_pack/blocks.json"), JSON.stringify(blocks));
    await writeFile(
      join(directory, "resource_pack/textures/terrain_texture.json"),
      "// Mojang catalog\n" + JSON.stringify({ texture_data: textureData }),
    );
    await writeFile(
      join(directory, "metadata/vanilladata_modules/mojang-blocks.json"),
      JSON.stringify({
        data_items: Object.keys(blocks).map((name) => ({ name: `minecraft:${name}` })),
      }),
    );
    for (const [name, rgba] of [
      ["alpha", [255, 0, 0, 255, 0, 0, 255, 0]],
      ["red", [255, 0, 0, 255]],
      ["green", [0, 255, 0, 255]],
      ["blue", [0, 0, 255, 255]],
      ["transparent", [255, 255, 255, 0]],
    ] as const) {
      const png = new PNG({ width: rgba.length / 4, height: 1 });
      png.data = Buffer.from(rgba);
      await writeFile(
        join(directory, `resource_pack/textures/blocks/${name}.png`),
        PNG.sync.write(png),
      );
    }
    await mkdir(join(directory, "resource_pack/textures/entity/bed"), { recursive: true });
    for (const color of [
      "white",
      "orange",
      "magenta",
      "light_blue",
      "yellow",
      "lime",
      "pink",
      "gray",
      "silver",
      "cyan",
      "purple",
      "blue",
      "brown",
      "green",
      "red",
      "black",
    ]) {
      const image = new PNG({ width: 64, height: 64 });
      for (let pixel = 0; pixel < 64 * 64; pixel++) image.data.set([0, 255, 0, 255], pixel * 4);
      for (const top of [6, 28])
        for (let y = top; y < top + 16; y++)
          for (let x = 6; x < 22; x++) image.data.set([0, 0, 255, 255], (y * 64 + x) * 4);
      await writeFile(
        join(directory, `resource_pack/textures/entity/bed/${color}.png`),
        PNG.sync.write(image),
      );
    }
    const tga = Buffer.alloc(26);
    tga[2] = 2;
    tga.writeUInt16LE(2, 12);
    tga.writeUInt16LE(1, 14);
    tga[16] = 32;
    tga[17] = 8;
    tga.set([0, 0, 255, 255, 255, 0, 0, 0], 18);
    await writeFile(join(directory, "resource_pack/textures/blocks/tga.tga"), tga);
    const rle = Buffer.alloc(22);
    rle[2] = 10;
    rle.writeUInt16LE(2, 12);
    rle.writeUInt16LE(1, 14);
    rle[16] = 24;
    rle.set([129, 0, 255, 0], 18);
    await writeFile(join(directory, "resource_pack/textures/blocks/tga_rle.tga"), rle);
    await run(process.execPath, [generator, directory, output, report]);
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("ignores transparent pixels and averages the four lateral faces equally", async () => {
    const generated = await readFile(output, "utf8");
    expect(generated).toContain("fixture_alpha: { colors: [0xff0000, 0xff0000, 0xff0000]");
    expect(generated).toContain("fixture_faces: { colors: [0xff0000, 0x408040, 0x0000ff]");
  });

  it("reports missing/transparent textures in a deterministic order", async () => {
    const coverage = JSON.parse(await readFile(report, "utf8")) as {
      total: number;
      sampled: number;
      unresolved: { block: string; reason: string }[];
    };
    expect(coverage.total).toBe(8);
    expect(coverage.sampled).toBe(5);
    expect(coverage.unresolved.map((entry) => entry.block)).toEqual([
      "fixture_missing",
      "fixture_missing_faces",
      "fixture_transparent",
    ]);
    expect(
      coverage.unresolved.find((entry) => entry.block === "fixture_missing_faces")?.reason,
    ).toBe("Texture unavailable (PNG/TGA): textures/blocks/missing_north");
  });

  it("samples mattress UVs instead of unused entity pixels and decodes alpha/RLE TGA", async () => {
    const generated = await readFile(output, "utf8");
    expect(generated).toContain("bed: { colors: [0x0000ff, 0x0000ff, 0x00ff00]");
    expect(generated).toContain("fixture_tga: { colors: [0xff0000, 0xff0000, 0xff0000]");
    expect(generated).toContain("fixture_tga_rle: { colors: [0x00ff00, 0x00ff00, 0x00ff00]");
  });

  it("reproduces identical source and coverage for identical resources", async () => {
    const before = await readFile(output, "utf8");
    const beforeReport = await readFile(report, "utf8");
    await run(process.execPath, [generator, directory, output, report]);
    expect(await readFile(output, "utf8")).toBe(before);
    expect(await readFile(report, "utf8")).toBe(beforeReport);
  });
});
