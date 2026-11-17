import type { DiscoveryGroup, DiscoveryKind } from "@mapelix/scene-prototype/discoveries";

export type DiscoveryLabelFormatter = (group: DiscoveryGroup, kind: DiscoveryKind) => string;

export function discoveryLabel(
  group: DiscoveryGroup,
  kind: DiscoveryKind,
  format?: DiscoveryLabelFormatter,
): string {
  return format
    ? format(group, kind)
    : `${kind.label} · ${group.count} block${group.count === 1 ? "" : "s"} · X ${group.x}, Y ${group.y}, Z ${group.z}`;
}
