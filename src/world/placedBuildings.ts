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
    let cx = 0, cy = 0, n = 0;
    for (let i = 2; i + 1 < row.length; i += 2) {
      const x = row[i], y = row[i + 1];
      if (typeof x !== 'number' || typeof y !== 'number') continue;
      cx += x; cy += y; n++;
    }
    if (n < 3) continue;
    PLACED_BUILDINGS.push({
      cx: cx / n,
      cy: cy / n,
      type,
      name,
      residence: RESIDENCE_TYPES.has(type),
    });
  }
}

/** Nearest placed building whose centroid is within `radiusTiles` of the
 *  player (game-pixel position). Returns null when none in range. When
 *  `residenceOnly`, non-residences are skipped. */
export function nearestPlacedBuilding(
  playerPx: number,
  playerPy: number,
  TILE: number,
  radiusTiles: number,
  residenceOnly: boolean,
): PlacedBuilding | null {
  const r2 = (radiusTiles * TILE) * (radiusTiles * TILE);
  let best: PlacedBuilding | null = null;
  let bestD2 = r2;
  for (const b of PLACED_BUILDINGS) {
    if (residenceOnly && !b.residence) continue;
    const bx = b.cx * TILE + TILE / 2;
    const by = b.cy * TILE + TILE / 2;
    const dx = playerPx - bx;
    const dy = playerPy - by;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = b; }
  }
  return best;
}
