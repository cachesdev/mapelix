import { expect, it, vi } from "vitest";
import { DISCOVERY_KINDS, type DiscoveryGroup } from "@mapelix/scene-prototype/discoveries";
import { discoveryLabel } from "./discovery-label";

const group: DiscoveryGroup = {
  dimension: "overworld",
  id: "chest-pair",
  kind: 13,
  x: -61,
  y: 69,
  z: 29,
  count: 2,
  exposed: 2,
  buried: 0,
  unknown: 0,
  minX: -61,
  maxX: -59,
  minY: 69,
  maxY: 70,
  minZ: 29,
  maxZ: 30,
};
const kind = DISCOVERY_KINDS[group.kind]!;

it("preserves the English plural fallback and exact signed coordinates", () => {
  expect(discoveryLabel(group, kind)).toBe("Chest · 2 blocks · X -61, Y 69, Z 29");
});
it("uses the singular fallback for one block", () => {
  expect(discoveryLabel({ ...group, count: 1 }, kind)).toBe("Chest · 1 block · X -61, Y 69, Z 29");
});
it("passes both source objects to the optional host formatter", () => {
  const format = vi.fn((g: DiscoveryGroup) => `Stored chest ×${g.count} · Y ${g.y}`);
  expect(discoveryLabel(group, kind, format)).toBe("Stored chest ×2 · Y 69");
  expect(format).toHaveBeenCalledExactlyOnceWith(group, kind);
});
