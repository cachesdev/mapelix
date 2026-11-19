import type { MarkerInput } from "@mapelix/viewer";

/**
 * Example markers around a point (the world spawn when the 3D world is served). A real host
 * would read them from its own store; Mapelix only draws what it is given.
 */
export function sampleMarkers(
  center: { x: number; z: number },
  spawnOnly = false,
): MarkerInput[] {
  const at = (dx: number, dz: number) => ({
    x: Math.round(center.x + dx),
    z: Math.round(center.z + dz),
  });
  const markers: MarkerInput[] = [
    {
      id: "spawn",
      ...at(0, 0),
      icon: "★",
      label: "World spawn",
      color: "#e0a526",
      group: "places",
      priority: 10,
    },
  ];
  if (spawnOnly) return markers;
  markers.push(
    {
      id: "village",
      ...at(150, -40),
      icon: "⌂",
      label: "Village",
      color: "#b9773f",
      group: "places",
      priority: 5,
    },
    {
      id: "portal",
      ...at(-180, 120),
      icon: "◎",
      label: "Nether portal",
      color: "#8a4fd6",
      group: "places",
      priority: 5,
    },
    {
      id: "lookout",
      ...at(-90, -160),
      icon: "▲",
      label: "Lookout",
      color: "#3f8f5a",
      group: "places",
    },
    {
      id: "mine",
      ...at(60, 210),
      y: -20,
      icon: "⛏",
      label: "Mine entrance, Y −20",
      color: "#6b7280",
      group: "places",
    },
    { id: "camp", ...at(230, 90), image: "/markers/flag.svg", label: "Base camp", group: "places" },
    {
      id: "nether-hub",
      x: Math.round(center.x / 8),
      z: Math.round(center.z / 8),
      dimension: "nether",
      icon: "◎",
      label: "Nether hub",
      color: "#8a4fd6",
      group: "places",
      priority: 5,
    },
  );
  // A survey: many points close together, grouped when zoomed out.
  let seed = 12_345;
  const random = () => (seed = (seed * 16_807) % 2_147_483_647) / 2_147_483_647;
  for (let i = 1; i <= 40; i += 1) {
    const angle = random() * Math.PI * 2,
      distance = 30 + random() * 260;
    markers.push({
      id: `survey-${i}`,
      ...at(320 + Math.cos(angle) * distance, 260 + Math.sin(angle) * distance),
      icon: String(i),
      label: `Survey point ${i}`,
      color: "#2f86c4",
      group: "survey",
    });
  }
  return markers;
}
