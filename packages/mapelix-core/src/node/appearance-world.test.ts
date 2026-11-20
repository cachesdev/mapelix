import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createBedrockWorld, type EffectiveBedrockRecord } from "@mapelix/prototype";
import {
  biomeRecord,
  sectionRecord,
  writeFixtureWorld,
} from "../../../mapelix-scene-prototype/test/dimension-fixture.js";
import { createMapWorld, openMapWorld } from "./index.js";
import { surfaceProfile } from "../surface-profiles.js";
import type { MapRenderOptions, MapAppearance, RenderedTile, TileCoordinates } from "../types.js";

const coordinates: TileCoordinates = { dimension: "overworld", z: 2, x: 0, y: 0 };
const leaves = [
  "red_poplar_leaves",
  "orange_poplar_leaves",
  "yellow_poplar_leaves",
  "pale_oak_leaves",
];
const foliage = (biome = 1) => [
  sectionRecord(0, 0, 0, 3, (x, y) =>
    y === 62 ? `minecraft:${leaves[Math.floor(x / 4)]}` : "minecraft:air",
  ),
  biomeRecord(0, 0, 0, Array<number>(24).fill(biome)),
];

async function render(
  records: Iterable<EffectiveBedrockRecord>,
  options: MapRenderOptions = {},
  tile = coordinates,
) {
  const world = createMapWorld(records);
  try {
    return await world.renderTile(tile, { ...options, includeSurface: true });
  } finally {
    await world.close();
  }
}

function pixel(tile: RenderedTile, worldX = 8, worldZ = 8) {
  const x = (worldX - tile.bounds.minX) * 4 + 2;
  const z = (worldZ - tile.bounds.minZ) * 4 + 2;
  return Array.from(tile.rgba.slice((z * 256 + x) * 4, (z * 256 + x + 1) * 4));
}

function sample(tile: RenderedTile, worldX = 8, worldZ = 8) {
  return tile.surface!.samples[(worldZ - tile.bounds.minZ) * 64 + worldX - tile.bounds.minX]!;
}

describe("modern classic 2D appearance", () => {
  it.each([1, 6, 195])("keeps four foliage colors distinct in biome %i", async (biome) => {
    const tile = await render(foliage(biome));
    expect([1, 5, 9, 13].map((x) => pixel(tile, x))).toEqual([
      [154, 44, 39, 255],
      [188, 86, 24, 255],
      [215, 134, 40, 255],
      [117, 122, 115, 255],
    ]);
    const blended = await render(foliage(biome), { biomeBlendRadius: 2 });
    expect(blended.png).toEqual(tile.png);
  });

  it.each([
    ["pink_petals", [238, 158, 196, 255]],
    ["leaf_litter", [150, 110, 60, 255]],
    ["wildflowers", [237, 214, 117, 255]],
    ["red_shrub", [122, 35, 22, 255]],
    ["firefly_bush", [88, 83, 43, 255]],
    ["short_dry_grass", [187, 159, 108, 255]],
    ["tall_dry_grass", [197, 172, 123, 255]],
    ["cactus_flower", [238, 158, 196, 255]],
    ["pale_moss_carpet", [107, 112, 105, 255]],
  ] as const)("colors %s without a false support step or opaque shadow", async (name, expected) => {
    const records = [
      sectionRecord(0, 0, 0, 3, (_x, y) => {
        if (y === 61) return "minecraft:stone";
        return y === 62 ? `minecraft:${name}` : "minecraft:air";
      }),
      biomeRecord(0, 0, 0, Array<number>(24).fill(1)),
    ];
    const tile = await render(records);
    expect(sample(tile)).toMatchObject({ name: `minecraft:${name}`, y: 62, supportY: 61 });
    expect(sample(tile).shadowRuns).toEqual([{ minY: 61, maxY: 61, opacity: 1 }]);
    expect(pixel(tile)).toEqual(expected);
    const cut = await render(records, { topY: 61 });
    expect(sample(cut)).toMatchObject({ name: "minecraft:stone", y: 61 });
    expect(sample(cut).supportY).toBeUndefined();
  });

  it("retains the terrain support beneath multiple decorative layers", async () => {
    const records = [
      sectionRecord(0, 0, 0, 3, (_x, y) => {
        if (y === 61) return "minecraft:stone";
        if (y === 62) return "minecraft:leaf_litter";
        if (y === 63) return "minecraft:pink_petals";
        return "minecraft:air";
      }),
    ];
    const modern = sample(await render(records));
    expect(modern).toMatchObject({ name: "minecraft:pink_petals", y: 63, supportY: 61 });
    expect(modern.shadowRuns).toEqual([{ minY: 61, maxY: 61, opacity: 1 }]);
    expect(sample(await render(records, { appearance: "reference" })).supportY).toBeUndefined();
  });

  it("keeps ground support coherent across a negative-coordinate tile seam", async () => {
    const records = [-1, 0].map((x) =>
      sectionRecord(0, x, 0, 3, (_x, y) => {
        if (y === 61) return "minecraft:stone";
        return y === 62 ? "minecraft:pink_petals" : "minecraft:air";
      }),
    );
    const left = await render(records, {}, { ...coordinates, x: -1 });
    const right = await render(records);
    expect(sample(left, -1)).toMatchObject({ y: 62, supportY: 61 });
    expect(sample(right, 0)).toMatchObject({ y: 62, supportY: 61 });
    const row = 34 * 256 * 4;
    expect(left.rgba.slice(row + 255 * 4, row + 256 * 4)).toEqual(right.rgba.slice(row, row + 4));
  });

  it("does not let neighboring small cover cast full-block shadows", async () => {
    const ground = Array.from({ length: 16 }, (_, i) =>
      sectionRecord(0, i % 4, Math.floor(i / 4), 3, (_x, y) =>
        y === 61 ? "minecraft:stone" : "minecraft:air",
      ),
    );
    const cover = sectionRecord(0, -1, -1, 6, (x, y, z) =>
      x === -1 && z === -1 && y === 100 ? "minecraft:red_shrub" : "minecraft:air",
    );
    expect((await render([...ground, cover])).png).toEqual((await render(ground)).png);
    const reference = await render([...ground, cover], { appearance: "reference" });
    expect(reference.png).not.toEqual((await render(ground, { appearance: "reference" })).png);
  });

  it.each([
    ["poplar_log", [136, 122, 110, 255]],
    ["poplar_planks", [136, 122, 110, 255]],
    ["pale_oak_wood", [87, 77, 75, 255]],
    ["pale_oak_stairs", [228, 218, 216, 255]],
    ["resin_bricks", [206, 89, 24, 255]],
  ] as const)("gives %s its own material color", async (name, expected) => {
    expect(
      pixel(
        await render([
          sectionRecord(0, 0, 0, 3, (_x, y) => (y === 62 ? `minecraft:${name}` : "minecraft:air")),
        ]),
      ),
    ).toEqual(expected);
  });

  it("matches the batch-1 renderer when reference appearance is selected", async () => {
    const records = foliage();
    const legacy = createBedrockWorld(records);
    try {
      const expected = await legacy.renderTile(coordinates, {
        surfaceRange: surfaceProfile("overworld"),
      });
      const actual = await render(records, { appearance: "reference" });
      expect(actual.png).toEqual(expected.png);
      expect((await render(records)).png).not.toEqual(expected.png);
    } finally {
      await legacy.close();
    }
  });

  it.each([
    ["y", [136, 122, 110, 255]],
    ["x", [79, 61, 43, 255]],
    ["z", [79, 61, 43, 255]],
  ] as const)("selects the upward visible face of a log on axis %s", async (axis, expected) => {
    const tile = await render([
      sectionRecord(0, 0, 0, 3, (_x, y) =>
        y === 62
          ? { name: "minecraft:poplar_log", states: { pillar_axis: axis } }
          : "minecraft:air",
      ),
    ]);
    expect(pixel(tile)).toEqual(expected);
  });

  it("keeps color-changing palette states, including legacy dyes and sampled variants", async () => {
    const colored = await render([
      sectionRecord(0, 0, 0, 3, (_x, y) =>
        y === 62 ? { name: "minecraft:wool", states: { color: "blue" } } : "minecraft:air",
      ),
    ]);
    expect(pixel(colored)).toEqual([53, 57, 157, 255]);
    const bulb = async (lit: number) =>
      render([
        sectionRecord(0, 0, 0, 3, (_x, y) =>
          y === 62
            ? { name: "minecraft:waxed_copper_bulb", states: { lit, powered_bit: 0 } }
            : "minecraft:air",
        ),
      ]);
    expect(pixel(await bulb(1))).not.toEqual(pixel(await bulb(0)));
  });

  it("uses all sixteen bed dyes when the caller provides their palette color state", async () => {
    const tile = await render([
      sectionRecord(0, 0, 0, 3, (x, y) =>
        y === 62 ? { name: "minecraft:bed", states: { color: x } } : "minecraft:air",
      ),
    ]);
    expect(new Set(Array.from({ length: 16 }, (_, x) => pixel(tile, x).join(","))).size).toBe(16);
    expect(pixel(tile, 0)).toEqual([215, 212, 205, 255]);
    expect(pixel(tile, 14)).toEqual([176, 99, 89, 255]);
    expect(sample(tile).style?.variants).toBeUndefined();
  });

  it("uses canonical legacy flower states without adding a terrain step", async () => {
    const tile = await render([
      sectionRecord(0, 0, 0, 3, (_x, y) =>
        y === 61
          ? "minecraft:stone"
          : y === 62
            ? { name: "minecraft:red_flower", states: { flower_type: "tulip_orange" } }
            : "minecraft:air",
      ),
    ]);
    expect(pixel(tile)).toEqual([240, 132, 40, 255]);
    expect(sample(tile).supportY).toBe(61);
  });

  it("keeps the shared crop color instead of sampling a texture's initial growth stage", async () => {
    const tile = await render([
      sectionRecord(0, 0, 0, 3, (_x, y) =>
        y === 61 ? "minecraft:stone" : y === 62 ? "minecraft:wheat" : "minecraft:air",
      ),
    ]);
    expect(pixel(tile)).toEqual([158, 150, 62, 255]);
    expect(sample(tile).supportY).toBe(61);
  });

  it("retains differently dyed glass layers when their legacy block name is identical", async () => {
    const tile = await render([
      sectionRecord(0, 0, 0, 3, (_x, y) => {
        if (y === 61) return "minecraft:stone";
        if (y === 62 || y === 63)
          return {
            name: "minecraft:stained_glass",
            states: { color: y === 63 ? "blue" : "red" },
          };
        return "minecraft:air";
      }),
    ]);
    const layers = sample(tile).colorLayers!;
    expect(layers).toHaveLength(3);
    expect(layers[0]!.name).toBe(layers[1]!.name);
    expect(layers[0]!.style!.color).not.toEqual(layers[1]!.style!.color);
    expect(layers[0]!.style!.color.alpha).toBe(127);
    expect(layers[0]!.style!.variants).toBeUndefined();
  });

  it.each([
    [193, [104, 114, 100, 255]],
    [194, [150, 145, 69, 255]],
    [195, [195, 91, 34, 255]],
  ] as const)(
    "retains shared modern biome %i ground colors through the catalog",
    async (biome, expected) => {
      const tile = await render([
        sectionRecord(0, 0, 0, 3, (_x, y) =>
          y === 62 ? "minecraft:grass_block" : "minecraft:air",
        ),
        biomeRecord(0, 0, 0, Array<number>(24).fill(biome)),
      ]);
      expect(pixel(tile)).toEqual(expected);
    },
  );

  it("transports modern appearance through workers and keeps reference jobs independent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mapelix-appearance-"));
    const post = vi.spyOn(Worker.prototype, "postMessage");
    try {
      const records = [
        ...foliage(),
        sectionRecord(0, 1, 0, 3, (_x, y) => {
          if (y === 61) return "minecraft:stone";
          return y === 62 ? "minecraft:pink_petals" : "minecraft:air";
        }),
      ];
      await writeFixtureWorld(directory, records);
      const world = await openMapWorld({ directory, renderConcurrency: 2 });
      try {
        for (const appearance of ["modern", "reference"] as const) {
          const tile = await world.renderTile(coordinates, { appearance });
          const job = post.mock.calls.at(-1)![0].job;
          if (appearance === "modern")
            expect(job.surfaceStyle["minecraft:pink_petals"].decorative).toBe(true);
          else expect(job.surfaceStyle).toBeUndefined();
          expect(Array.from(tile.png)).toEqual(
            Array.from((await render(records, { appearance })).png),
          );
        }
      } finally {
        await world.close();
      }
    } finally {
      post.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["classic", null, 1])("rejects unsupported appearance %s", async (appearance) => {
    await expect(render([], { appearance: appearance as MapAppearance })).rejects.toThrow(
      RangeError,
    );
  });
});
