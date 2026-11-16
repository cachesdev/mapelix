import { describe, expect, it } from "vitest";
import { decodePng } from "@mapelix/prototype/png";

import { createOverviewTile, type OverviewSourceTile } from "./overview.js";

const coordinates = { dimension: "the-end" as const, z: -1, x: -1, y: -1 };

describe("streaming overview PNG adapter", () => {
  it("writes a 256px RGBA tile with exact negative bounds and transparent missing sources", async () => {
    const rgba = new Uint8Array(256 * 256 * 4);
    for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([30, 150, 90, 128], offset);
    const tile = await createOverviewTile(coordinates, [
      { coordinates: { ...coordinates, z: 0 }, rgba },
    ]);
    expect(tile.bounds).toEqual({ minX: -512, minZ: -512, maxX: 0, maxZ: 0 });
    expect([tile.width, tile.height]).toEqual([256, 256]);
    expect(
      Array.from(tile.rgba.subarray((128 * 256 + 128) * 4, (128 * 256 + 128) * 4 + 4)),
    ).toEqual([30, 150, 90, 128]);
    expect(Array.from(decodePng(tile.png, 256, 256))).toEqual(Array.from(tile.rgba));
    expect((await createOverviewTile(coordinates, [])).rgba.every((value) => value === 0)).toBe(
      true,
    );
  });

  it("settles cancellation and closes its async source iterator", async () => {
    const controller = new AbortController();
    let closed = false;
    async function* sources(): AsyncGenerator<OverviewSourceTile> {
      try {
        yield { coordinates: { ...coordinates, z: 0 }, rgba: new Uint8Array(256 * 256 * 4) };
        controller.abort();
        yield { coordinates: { ...coordinates, z: 0, x: -2 }, rgba: new Uint8Array(256 * 256 * 4) };
      } finally {
        closed = true;
      }
    }
    await expect(
      createOverviewTile(coordinates, sources(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(closed).toBe(true);
    await expect(createOverviewTile(coordinates, [], AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
