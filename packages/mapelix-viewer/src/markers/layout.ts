/**
 * Screen layout of markers, without the DOM: grouping of points that are too close, and label
 * placement without overlap. Pure functions, so they are tested on their own.
 */

/** A group of points drawn as one item: its leader (the first point in priority order) and the rest. */
export interface ScreenCluster {
  /** Index, in the input order, of the point that leads the group and gives its place. */
  readonly leader: number;
  /** Indices of every point in the group, the leader first. */
  readonly members: number[];
  readonly x: number;
  readonly y: number;
}

/**
 * Groups points closer than `radius` pixels to an earlier group leader. Points come in priority
 * order, so a higher-priority point always keeps its own place; with a pan in 2D or in the
 * isometric 3D view, every distance stays the same, so the groups do not change.
 */
export function clusterPoints(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
  radius: number,
): ScreenCluster[] {
  const clusters: ScreenCluster[] = [];
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 65_536 + cy;
  const radius2 = radius * radius;
  for (let index = 0; index < count; index += 1) {
    const x = xs[index]!,
      y = ys[index]!;
    const cx = Math.floor(x / radius),
      cy = Math.floor(y / radius);
    let best: ScreenCluster | undefined;
    let bestDistance = radius2;
    for (let dx = -1; dx <= 1; dx += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        const cell = cells.get(key(cx + dx, cy + dy));
        if (cell === undefined) continue;
        for (const id of cell) {
          const cluster = clusters[id]!;
          const distance = (cluster.x - x) ** 2 + (cluster.y - y) ** 2;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = cluster;
          }
        }
      }
    if (best !== undefined) {
      best.members.push(index);
      continue;
    }
    const id = clusters.length;
    clusters.push({ leader: index, members: [index], x, y });
    const cell = cells.get(key(cx, cy));
    if (cell === undefined) cells.set(key(cx, cy), [id]);
    else cell.push(id);
  }
  return clusters;
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface LabelRequest {
  /** Center of the item the label belongs to. */
  readonly x: number;
  readonly y: number;
  /** Size of the label box. */
  readonly width: number;
  readonly height: number;
}

/** Offset of a placed label's top left corner from its item center. */
export interface LabelPlacement {
  readonly dx: number;
  readonly dy: number;
}

const GAP = 4;

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Places labels in request order (the most important first) to the right, left, below or above
 * their item, where they overlap no item, no obstacle and no label placed before, and stay inside
 * the view. A label that fits nowhere is left out (`undefined`).
 */
export function placeLabels(
  requests: readonly (LabelRequest | undefined)[],
  items: readonly { readonly x: number; readonly y: number }[],
  itemRadius: number,
  obstacles: readonly Box[],
  width: number,
  height: number,
): (LabelPlacement | undefined)[] {
  const taken: Box[] = [...obstacles];
  for (const item of items)
    taken.push({
      left: item.x - itemRadius,
      top: item.y - itemRadius,
      right: item.x + itemRadius,
      bottom: item.y + itemRadius,
    });
  return requests.map((request) => {
    if (request === undefined) return undefined;
    const { x, y, width: w, height: h } = request;
    const candidates: LabelPlacement[] = [
      { dx: itemRadius + GAP, dy: -h / 2 },
      { dx: -itemRadius - GAP - w, dy: -h / 2 },
      { dx: -w / 2, dy: itemRadius + GAP },
      { dx: -w / 2, dy: -itemRadius - GAP - h },
    ];
    for (const candidate of candidates) {
      const box = {
        left: x + candidate.dx,
        top: y + candidate.dy,
        right: x + candidate.dx + w,
        bottom: y + candidate.dy + h,
      };
      if (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height) continue;
      if (taken.some((other) => overlaps(box, other))) continue;
      taken.push(box);
      return candidate;
    }
    return undefined;
  });
}

/** An image address a marker may load: http(s), protocol-relative or a relative path. */
export function safeImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 2048) return undefined;
  // Any other scheme (data:, javascript:, blob:, file: …) is refused.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== undefined && scheme !== "http" && scheme !== "https") return undefined;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code < 0x20 || code === 0x5c) return undefined;
  }
  return trimmed;
}
