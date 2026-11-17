import { describe, expect, it } from "vitest";
import { clusterPoints, placeLabels, safeImageUrl } from "./layout";
import { checkMarker } from "./marker-layer";

function cluster(points: [number, number][], radius = 48) {
  return clusterPoints(
    points.map(([x]) => x),
    points.map(([, y]) => y),
    points.length,
    radius,
  );
}

describe("clusterPoints", () => {
  it("keeps distant points apart and groups close ones under the first", () => {
    const groups = cluster([
      [100, 100],
      [400, 100],
      [110, 105],
      [395, 90],
      [700, 300],
    ]);
    expect(groups.map((group) => group.members)).toEqual([[0, 2], [1, 3], [4]]);
    expect(groups[0]).toMatchObject({ leader: 0, x: 100, y: 100 });
  });

  it("leaves no two leaders closer than the radius", () => {
    const xs: number[] = [],
      ys: number[] = [];
    let seed = 7;
    const random = () => ((seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647) * 800;
    for (let i = 0; i < 1000; i += 1) {
      xs.push(random());
      ys.push(random());
    }
    const groups = clusterPoints(xs, ys, xs.length, 48);
    expect(groups.reduce((sum, group) => sum + group.members.length, 0)).toBe(1000);
    for (const [i, a] of groups.entries())
      for (const b of groups.slice(i + 1))
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(48);
  });

  it("gives the same groups after a pan", () => {
    const points: [number, number][] = [
      [10, 10],
      [40, 30],
      [90, 10],
      [300, 300],
      [320, 310],
    ];
    const moved = points.map(([x, y]) => [x + 173.5, y - 61.25] as [number, number]);
    expect(cluster(moved).map((group) => group.members)).toEqual(
      cluster(points).map((group) => group.members),
    );
  });
});

describe("placeLabels", () => {
  const overlap = (a: number[], b: number[]) =>
    a[0]! < b[2]! && b[0]! < a[2]! && a[1]! < b[3]! && b[1]! < a[3]!;

  it("places labels without overlap, inside the view, around obstacles", () => {
    const items = [
      { x: 100, y: 100 },
      { x: 140, y: 100 },
      { x: 120, y: 140 },
      { x: 360, y: 20 },
    ];
    const requests = items.map((item) => ({ ...item, width: 90, height: 22 }));
    const obstacle = { left: 300, top: 0, right: 400, bottom: 60 };
    const placements = placeLabels(requests, items, 16, [obstacle], 400, 300);
    const boxes = placements.flatMap((placement, index) =>
      placement === undefined
        ? []
        : [
            [
              items[index]!.x + placement.dx,
              items[index]!.y + placement.dy,
              items[index]!.x + placement.dx + 90,
              items[index]!.y + placement.dy + 22,
            ],
          ],
    );
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const [i, a] of boxes.entries()) {
      expect(a[0]).toBeGreaterThanOrEqual(0);
      expect(a[2]).toBeLessThanOrEqual(400);
      expect(overlap(a, [300, 0, 400, 60])).toBe(false);
      for (const item of items)
        expect(overlap(a, [item.x - 16, item.y - 16, item.x + 16, item.y + 16])).toBe(false);
      for (const b of boxes.slice(i + 1)) expect(overlap(a, b)).toBe(false);
    }
    // The item under the obstacle has nowhere to put its label.
    expect(placements[3]).toBeUndefined();
  });

  it("puts the first request first", () => {
    const items = [
      { x: 100, y: 50 },
      { x: 100, y: 60 },
    ];
    const [first] = placeLabels(
      items.map((item) => ({ ...item, width: 60, height: 22 })),
      items,
      16,
      [],
      400,
      200,
    );
    expect(first).toEqual({ dx: 20, dy: -11 });
  });
});

describe("marker checks", () => {
  it("accepts only http(s) and relative images", () => {
    expect(safeImageUrl("https://example.test/a.png")).toBe("https://example.test/a.png");
    expect(safeImageUrl("http://example.test/a.png")).toBeDefined();
    expect(safeImageUrl("/icons/a.png")).toBe("/icons/a.png");
    expect(safeImageUrl("icons/a.png")).toBe("icons/a.png");
    expect(safeImageUrl("//cdn.example.test/a.png")).toBeDefined();
    for (const bad of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:image/png;base64,AAAA",
      "blob:https://example.test/1",
      "file:///etc/passwd",
      "java\nscript:alert(1)",
      "",
      42,
    ])
      expect(safeImageUrl(bad)).toBeUndefined();
  });

  it("keeps data untouched, drops unusable fields and refuses markers without a place", () => {
    const data = { anything: "<img src=x onerror=alert(1)>" };
    const marker = checkMarker({
      id: "a",
      x: 1,
      z: 2,
      dimension: "end",
      label: "  <b>Base</b>  ",
      image: "javascript:alert(1)",
      priority: Number.NaN,
      data,
    });
    expect(marker).toMatchObject({
      id: "a",
      x: 1,
      z: 2,
      dimension: "the-end",
      label: "<b>Base</b>",
    });
    expect(marker?.image).toBeUndefined();
    expect(marker?.priority).toBeUndefined();
    expect(marker?.data).toBe(data);
    expect(Object.isFrozen(marker)).toBe(true);
    expect(checkMarker({ id: "", x: 1, z: 2 })).toBeUndefined();
    expect(checkMarker({ id: "b", x: Number.POSITIVE_INFINITY, z: 2 })).toBeUndefined();
  });
});
