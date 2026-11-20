import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createBedrockWorld, type EffectiveBedrockRecord } from "@mapelix/prototype";
import {
  biomeRecord,
  chunkKey,
  sectionRecord,
  writeFixtureWorld,
} from "../../../mapelix-scene-prototype/test/dimension-fixture.js";

import { createMapWorld, openMapWorld } from "./index.js";
import type { MapRenderOptions, RenderedTile, TileCoordinates } from "../types.js";

const coordinates: TileCoordinates = { dimension: "nether", z: 2, x: 0, y: 0 };
const netherRecords = () => [
  sectionRecord(1, 0, 0, 5, (_x, y) => {
    if (y === 80) return "minecraft:netherrack";
    if (y === 90) return "minecraft:gold_block";
    if (y === 91) return "minecraft:diamond_block";
    return "minecraft:air";
  }),
  sectionRecord(1, 0, 0, 7, (_x, y) => (y === 127 ? "minecraft:bedrock" : "minecraft:air")),
  biomeRecord(1, 0, 0, [8, 8, 8, 8, 8, 179, 180, 178]),
];

async function render(
  records: Iterable<EffectiveBedrockRecord>,
  tile = coordinates,
  options: MapRenderOptions = {},
): Promise<RenderedTile> {
  const world = createMapWorld(records);
  try {
    return await world.renderTile(tile, { ...options, includeSurface: true });
  } finally {
    await world.close();
  }
}

function sample(tile: RenderedTile, x = tile.bounds.minX, z = tile.bounds.minZ) {
  return tile.surface!.samples[
    (z - tile.bounds.minZ) * tile.surface!.sampleSize + x - tile.bounds.minX
  ];
}

describe("dimension-aware classic map surfaces", () => {
  it("keeps the End void transparent even when biome metadata exists", async () => {
    const tile = await render([biomeRecord(2, 0, 0, Array<number>(16).fill(9))], {
      ...coordinates,
      dimension: "the-end",
    });
    expect(tile.surface!.samples.every((value) => value === undefined)).toBe(true);
    expect(tile.rgba.every((value) => value === 0)).toBe(true);
  });

  it.each([
    ["nether", 1],
    ["the-end", 2],
  ] as const)("excludes negative blocks beneath the %s floor", async (dimension, storageId) => {
    const tile = await render(
      [
        sectionRecord(storageId, 0, 0, -1, "minecraft:bedrock"),
        sectionRecord(storageId, 0, 0, 0, (_x, y) =>
          y === 0 ? "minecraft:stone" : "minecraft:air",
        ),
      ],
      { ...coordinates, dimension },
      { topY: 0 },
    );
    expect(sample(tile)).toMatchObject({ name: "minecraft:stone", y: 0 });
    expect(sample(tile)!.shadowRuns).toEqual([{ minY: 0, maxY: 0, opacity: 1 }]);
  });

  it("allows an empty cut at the Nether floor", async () => {
    expect(
      (await render(netherRecords(), coordinates, { topY: 0 })).rgba.every((value) => value === 0),
    ).toBe(true);
  });

  it.each([
    [undefined, "minecraft:gold_block", 90, 179],
    [89, "minecraft:netherrack", 80, 179],
    [91, "minecraft:diamond_block", 91, 179],
    [127, "minecraft:bedrock", 127, 178],
  ] as const)("includes the exact Nether cut %s", async (topY, name, y, biomeId) => {
    const tile = await render(netherRecords(), coordinates, topY === undefined ? {} : { topY });
    expect(sample(tile)).toMatchObject({ name, y, biomeId });
    expect(
      sample(tile)!.shadowRuns!.every((run) => run.minY >= 0 && run.maxY <= (topY ?? 90)),
    ).toBe(true);
  });

  it("keeps same-coordinate dimensions independent through their physical upper bounds", async () => {
    const records = [
      sectionRecord(0, 0, 0, 19, "minecraft:grass_block"),
      sectionRecord(0, 0, 0, 20, "minecraft:bedrock"),
      ...netherRecords(),
      sectionRecord(2, 0, 0, 15, "minecraft:end_stone"),
      sectionRecord(2, 0, 0, 16, "minecraft:bedrock"),
    ];
    for (const [dimension, name, y] of [
      ["overworld", "minecraft:grass_block", 319],
      ["nether", "minecraft:gold_block", 90],
      ["the-end", "minecraft:end_stone", 255],
    ] as const) {
      expect(sample(await render(records, { ...coordinates, dimension }))).toMatchObject({
        name,
        y,
      });
    }
  });

  it("supports a negative included cut and excludes blocks below the Overworld floor", async () => {
    const records = [
      sectionRecord(0, -1, -1, -5, "minecraft:diamond_block"),
      sectionRecord(0, -1, -1, -4, (_x, y) => (y === -64 ? "minecraft:stone" : "minecraft:air")),
      biomeRecord(0, -1, -1, Array<number>(24).fill(12)),
    ];
    const tile = await render(
      records,
      { dimension: "overworld", z: 2, x: -1, y: -1 },
      { topY: -64 },
    );
    expect(sample(tile, -1, -1)).toMatchObject({ name: "minecraft:stone", y: -64, biomeId: 12 });
    expect(sample(tile, -1, -1)!.shadowRuns).toEqual([{ minY: -64, maxY: -64, opacity: 1 }]);
    const missing = await render([records[0]!], { dimension: "overworld", z: 2, x: -1, y: -1 });
    expect(missing.rgba.every((value) => value === 0)).toBe(true);
  });

  it("preserves repeat-below biome slots across missing block sections and the height cut", async () => {
    const biomes = new Uint8Array(512 + 5 + 4 + 5 + 2);
    biomes.set([1, 8, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 1, 179, 0, 0, 0, 0xff, 0xff], 512);
    const tile = await render([
      ...netherRecords().filter((record) => record.key[12] !== 0x2b),
      { key: chunkKey(1, 0, 0, 0x2b), value: biomes },
    ]);
    expect(sample(tile)).toMatchObject({ y: 90, biomeId: 179 });
  });

  it("falls back to Data2D when Data3D does not describe the visible section", async () => {
    const data2D = new Uint8Array(768);
    data2D.fill(180, 512);
    const tile = await render([
      ...netherRecords().filter((record) => record.key[12] !== 0x2b),
      biomeRecord(1, 0, 0, [8]),
      { key: chunkKey(1, 0, 0, 0x2d), value: data2D },
    ]);
    expect(sample(tile)).toMatchObject({ y: 90, biomeId: 180 });
  });

  it("clips water depth, glass layers and opacity runs before compositing", async () => {
    const records = [
      sectionRecord(1, 0, 0, 4, (_x, y) => {
        if (y === 68) return "minecraft:stone";
        if (y >= 69 && y <= 72) return "minecraft:water";
        if (y === 73) return "minecraft:red_stained_glass";
        if (y === 74) return "minecraft:blue_stained_glass";
        return "minecraft:air";
      }),
    ];
    expect(sample(await render(records, coordinates, { topY: 71 }))).toMatchObject({
      name: "minecraft:water",
      y: 71,
      fluidDepth: 3,
      underwaterName: "minecraft:stone",
    });
    const glass = sample(await render(records, coordinates, { topY: 73 }))!;
    expect(glass.colorLayers).toHaveLength(2);
    expect(glass.colorLayers).toMatchObject([
      { name: "minecraft:red_stained_glass", count: 1 },
      { name: "minecraft:water", count: 1, fluidDepth: 4, underwaterName: "minecraft:stone" },
    ]);
    expect(glass.shadowRuns!.every((run) => run.maxY <= 73)).toBe(true);
  });

  it("removes decorative cover above the cut without changing the ground height", async () => {
    const records = [
      sectionRecord(1, 0, 0, 5, (_x, y) => {
        if (y === 90) return "minecraft:grass_block";
        if (y === 91) return "minecraft:short_grass";
        return "minecraft:air";
      }),
    ];
    expect(sample(await render(records))).toMatchObject({ name: "minecraft:grass_block", y: 90 });
    expect(sample(await render(records, coordinates, { topY: 91 }))).toMatchObject({
      name: "minecraft:short_grass",
      y: 91,
      supportY: 90,
    });
  });

  it("does not let excluded blocks in a neighboring tile cast shadows through the cut", async () => {
    const ground = Array.from({ length: 16 }, (_, index) =>
      sectionRecord(1, index % 4, Math.floor(index / 4), 5, (_x, y) =>
        y === 80 ? "minecraft:stone" : "minecraft:air",
      ),
    );
    const caster = sectionRecord(1, -1, -1, 6, (x, y, z) =>
      x === -1 && z === -1 && y === 100 ? "minecraft:stone" : "minecraft:air",
    );
    const hidden = await render([...ground, caster]);
    expect(hidden.png).toEqual((await render(ground)).png);
    const included = await render([...ground, caster], coordinates, { topY: 100 });
    const shadowless = await render([...ground, caster], coordinates, {
      topY: 100,
      shadows: false,
    });
    expect(included.rgba).not.toEqual(shadowless.rgba);
  });

  it("leaves the legacy prototype's uncut behavior unchanged", async () => {
    const world = createBedrockWorld(netherRecords());
    try {
      expect(sample(await world.renderTile(coordinates, { includeSurface: true }))).toMatchObject({
        name: "minecraft:bedrock",
        y: 127,
      });
    } finally {
      await world.close();
    }
  });

  it("passes height profiles through real workers and preserves reader/byte parity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mapelix-profile-"));
    const post = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await writeFixtureWorld(directory, netherRecords());
      const world = await openMapWorld({ directory, renderConcurrency: 2 });
      try {
        const tile = await world.renderTile(coordinates);
        expect(post).toHaveBeenCalledWith(
          expect.objectContaining({
            job: expect.objectContaining({
              surfaceRange: expect.objectContaining({ minY: 0, maxY: 128, topY: 90 }),
            }),
          }),
        );
        expect(Array.from(tile.png)).toEqual(Array.from((await render(netherRecords())).png));
        await expect(world.renderTile(coordinates, { topY: 128 })).rejects.toThrow(RangeError);
        await world.close();
        await expect(world.renderTile(coordinates)).rejects.toThrow("closed");
      } finally {
        await world.close({ abort: true });
      }
    } finally {
      post.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
