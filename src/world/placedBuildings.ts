/**
 * H997: runtime registry of editor-placed buildings.
 *
 * Editor buildings are otherwise TILE-ONLY at runtime — _weStampBuilding
 * bakes their footprint into tile=17 and drops the row's name/type. This
 * registry keeps the per-building identity (centroid + type + name) the
 * gameplay layer needs to make a placed building enterable (residence ->
 * garage) or, later, purchasable / a dealership / a mechanic.
 *
 * Rebuilt from the SAME localStorage `buildings` rows the tile bake reads
 * (buildBaselineMap), so it stays in sync on boot and on editor Ctrl+S
 * with zero extra persistence. Row schema: [name, type, x1,y1, x2,y2, ...]
 * (H996 presets set a meaningful type; legacy hand-drawn rows default to
 * 'house').
 */

export interface PlacedBuilding {
  /** Footprint centroid, TILE coords. */
  cx: number;
  cy: number;
  /** Preset type (row[1]) — trailer / house2..4 / apartment / dealership
   *  / mechanic / house (legacy freeform). */
  type: string;
  /** Display name (row[0]). */
  name: string;
  /** True for residence types — enterable as a garage (opens the home
   *  overlay). Non-residences (dealer/mechanic) are registered but not
   *  yet garage-enterable. */
  residence: boolean;
  /** H998: footprint half-extent in TILES (max corner distance from the
   *  centroid). The ENTER prompt fires when the player is within
   *  `radius + approach` of the centroid — since H998 made buildings
   *  SOLID, the player parks at the footprint EDGE (~radius from centroid)
   *  and could never reach a fixed centroid radius on a large building. */
  radius: number;
}

export const PLACED_BUILDINGS: PlacedBuilding[] = [];

/** Residence preset types that open the garage/home overlay on entry. */
const RESIDENCE_TYPES = new Set([
  'trailer', 'house', 'house2', 'house3', 'house4', 'apartment',
]);

/** Human label for a building type (HUD prompt / marker). */
export function placedBuildingLabel(b: PlacedBuilding): string {
  if (b.name && b.name !== 'Building') return b.name;
  switch (b.type) {
    case 'trailer': return 'Trailer';
    case 'house2': return '2-Bed House';
    case 'house3': return '3-Bed House';
    case 'house4': return '4-Bed House';
    case 'apartment': return 'Apartment';
    case 'dealership': return 'Car Dealer';
    case 'mechanic': return 'Mechanic';
    case 'junkyard': return 'Junkyard';
    default: return 'House';
  }
}

/** Rebuild the registry from the localStorage building rows. Called from
 *  buildBaselineMap alongside the tile stamp. */
export function rebuildPlacedBuildings(
  rows: ReadonlyArray<unknown>,
): void {
  PLACED_BUILDINGS.length = 0;
  for (const rowRaw of rows) {
    const row = rowRaw as readonly (string | number)[];
    if (!Array.isArray(row) || row.length < 8) continue;
    const name = String(row[0] ?? '');
    const type = String(row[1] ?? 'house');
    const corners: Array<[number, number]> = [];
    let cx = 0, cy = 0;
    for (let i = 2; i + 1 < row.length; i += 2) {
      const x = row[i], y = row[i + 1];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      corners.push([x, y]);
      cx += x; cy += y;
    }
    if (corners.length < 3) continue;
    cx /= corners.length; cy /= corners.length;
    let radius = 0;
    for (const [x, y] of corners) {
      const d = Math.hypot(x - cx, y - cy);
      if (d > radius) radius = d;
    }
    PLACED_BUILDINGS.push({
      cx, cy, type, name,
      residence: RESIDENCE_TYPES.has(type),
      radius,
    });
  }
}

/** Nearest placed building the player can enter — within
 *  `approachTiles + building.radius` of its centroid (H998: buildings are
 *  solid, so the player parks at the footprint edge ~radius away). Returns
 *  null when none in range. `residenceOnly` skips dealer/mechanic. Ranks
 *  by EDGE distance so a small nearby building beats a huge distant one. */
export function nearestPlacedBuilding(
  playerPx: number,
  playerPy: number,
  TILE: number,
  approachTiles: number,
  residenceOnly: boolean,
): PlacedBuilding | null {
  let best: PlacedBuilding | null = null;
  let bestEdge = Infinity;
  for (const b of PLACED_BUILDINGS) {
    if (residenceOnly && !b.residence) continue;
    const bx = b.cx * TILE + TILE / 2;
    const by = b.cy * TILE + TILE / 2;
    const dist = Math.hypot(playerPx - bx, playerPy - by);
    const edge = dist - b.radius * TILE; // ~distance to footprint edge
    if (edge <= approachTiles * TILE && edge < bestEdge) {
      bestEdge = edge;
      best = b;
    }
  }
  return best;
}
