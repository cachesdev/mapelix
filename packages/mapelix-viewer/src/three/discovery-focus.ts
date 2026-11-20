import {
  CAVE_LIMITS,
  DIMENSIONS,
  sceneContext,
  type SceneContext,
} from "@mapelix/scene-prototype/dimensions";
import {
  DISCOVERY_KINDS,
  unpackDiscoveryBlock,
  type DiscoveryGroup,
  type DiscoveryTile,
} from "@mapelix/scene-prototype/discoveries";

/** Cooperatively filter source tiles using loaded terrain, preserving cached packets. */
export function* surfaceDiscoveryTiles(
  tiles: readonly DiscoveryTile[],
  visible: (x: number, y: number, z: number, kind: number) => boolean,
): Generator<void, readonly DiscoveryTile[]> {
  const result: DiscoveryTile[] = [];
  let scanned = 0;
  for (const tile of tiles) {
    const words: number[] = [];
    for (const word of tile.blocks) {
      if (++scanned % 256 === 0) yield;
      const block = unpackDiscoveryBlock(tile, word);
      if (block.exposure === "exposed" && visible(block.x, block.y, block.z, block.kind))
        words.push(word);
    }
    result.push({ ...tile, blocks: Uint32Array.from(words) });
  }
  return result;
}

/** Only positively verified exterior objects stay on Surface. */
export function discoveryContext(
  group: DiscoveryGroup,
  current: SceneContext,
  surfaceVisible = false,
  surfaceThickness: number = CAVE_LIMITS.defaultThickness,
): SceneContext {
  if (group.dimension !== current.dimension)
    throw new RangeError("Discovery belongs to another dimension");
  if (current.mode === "surface" && group.y < current.maxY && surfaceVisible) return current;
  if (current.mode === "caves" && group.y >= current.minY && group.y < current.maxY) return current;
  const thickness = current.mode === "caves" ? current.maxY - current.minY : surfaceThickness;
  const limits = DIMENSIONS[group.dimension];
  const minY = Math.max(
    limits.minY,
    Math.min(limits.maxY - thickness, Math.ceil((group.y + 1) / 16) * 16 - thickness),
  );
  return sceneContext(group.dimension, { mode: "caves", minY, maxY: minY + thickness });
}

export function discoveryDistance(
  group: DiscoveryGroup,
  previous: number,
  clearance?: { readonly maxY: number; readonly pitch: number; readonly exposed?: boolean },
): number {
  const span = Math.max(group.maxX - group.minX, group.maxY - group.minY, group.maxZ - group.minZ);
  const nominal = Math.max(18, Math.min(40, 16 + span * 1.5));
  const exposed = clearance?.exposed ?? (group.exposed === group.count && group.unknown === 0);
  if (exposed) return Math.min(previous, nominal);
  // A ray from a buried block meets an exit face, not an obstacle in open air.
  // Back out above the slice instead of putting a close camera inside that block.
  const outside = clearance
    ? (clearance.maxY - group.y + 0.75) / Math.max(0.1, Math.sin(clearance.pitch))
    : 0;
  return Math.min(CAVE_LIMITS.viewDistance * 0.75, Math.max(nominal, outside));
}

export interface DiscoveryDetailText {
  readonly title: string;
  readonly lines: readonly string[];
  readonly closeLabel?: string;
}

export function defaultDiscoveryDetails(group: DiscoveryGroup): DiscoveryDetailText {
  return {
    title: `${DISCOVERY_KINDS[group.kind]?.label ?? "Discovery"} × ${group.count}`,
    lines: [
      `X ${group.x} · Y ${group.y} · Z ${group.z}`,
      `${group.exposed} exposed · ${group.buried} buried · ${group.unknown} uncertain`,
    ],
    closeLabel: "Close discovery details",
  };
}
