/**
 * H1033: parked-car registry for the CAR MEET map.
 *
 * A car meet is a lot full of STATIC cars the player drives up to. These are
 * NOT ambient traffic (traffic.ts cars are spline-bound + simulated every
 * frame) — a parked car is just a catalog id + a fixed world pose, drawn with
 * the same drawPlayerCarV2 renderer the AI rival uses (so each shows its own
 * chassis/paint). The set is rebuilt from the active map's parking lot on every
 * switchMap (mirrors rebuildPlacedBuildings), so it fills on entry and clears
 * automatically on return to the city.
 *
 * Placement: one car in a random ~60% of the stalls computeStallLayout finds,
 * centred in the stall and aligned to the stall's long axis (nose out toward
 * the aisle, flipped for ~half so the rows aren't all facing one way). Distinct
 * catalog cars (bikes + utility/job vehicles excluded) up to the pool size.
 */
import { computeStallLayout } from '@/editor/parkingLayout';
import { _weParseParkingLotMeta } from '@/editor/stamp';
import { CAR_CATALOG, ALL_CAR_IDS } from '@/config/cars/catalog';
import { TILE } from '@/config/world/tiles';
import { getActiveMapLots } from './mapRuntime';

export interface ParkedCar {
  /** Catalog id — resolved through CAR_CATALOG by the renderer. */
  id: string;
  name: string;
  /** Fixed world pose (px). */
  x: number;
  y: number;
  angle: number;
}

let PARKED_CARS: ParkedCar[] = [];

export function getParkedCars(): readonly ParkedCar[] {
  return PARKED_CARS;
}
export function resetParkedCars(): void {
  PARKED_CARS = [];
}
/** H1034: pull one car out of the lot — the challenged car "drives to the
 *  line", so it shouldn't also remain parked in its stall (a duplicate). The
 *  set is rebuilt fresh on the next map switch, so this needn't persist. */
export function removeParkedCar(id: string): void {
  const i = PARKED_CARS.findIndex((c) => c.id === id);
  if (i >= 0) PARKED_CARS.splice(i, 1);
}

/** Vehicles kept out of the meet so it reads as a car/tuner meet, not a depot.
 *  Same utility set the race opponent generator excludes (race.ts NON_RACE_IDS). */
const MEET_EXCLUDE = new Set(['ambulance', 'tow_truck', 'police_cruiser', 'semi_truck', 'box_truck']);

/** Fraction of stalls left EMPTY — a lively-but-not-jammed lot. */
const EMPTY_CHANCE = 0.38;

/** Rebuild the parked-car set from the ACTIVE map's parking lots. Empty on any
 *  map without lots (city / drag / oval), so it self-clears on map switch. */
export function rebuildParkedCars(): void {
  PARKED_CARS = [];
  const lots = getActiveMapLots();
  if (!lots.length) return;

  // Candidate pool: real cars only (no bikes, no utility/job vehicles).
  const pool: string[] = [];
  for (const id of ALL_CAR_IDS) {
    const c = CAR_CATALOG[id];
    if (c && !c.isBike && !MEET_EXCLUDE.has(id)) pool.push(id);
  }
  if (!pool.length) return;
  // Shuffle (same idiom as sim/carLot.generateCarLot) so each visit differs.
  const shuffled = pool.slice().sort(() => Math.random() - 0.5);
  let pick = 0;

  for (const rowRaw of lots) {
    if (pick >= shuffled.length) break;
    const row = rowRaw as unknown[];
    if (!Array.isArray(row) || row.length < 7) continue;
    const meta = _weParseParkingLotMeta(row);
    const pts: [number, number][] = [];
    for (let k = meta.xStart; k + 1 < row.length; k += 2) {
      pts.push([row[k] as number, row[k + 1] as number]);
    }
    if (pts.length < 3) continue;

    const layout = computeStallLayout(pts, {
      stallW: meta.stallW, stallL: meta.stallL, aisleW: meta.aisleW, maxAdaPerRow: 0,
    });
    for (const s of layout.stalls) {
      if (pick >= shuffled.length) break;      // out of distinct cars
      if (Math.random() < EMPTY_CHANCE) continue; // leave some spots open
      const id = shuffled[pick++];
      const c = s.corners;
      // Stall centre (tile → world px).
      const cx = (c[0][0] + c[1][0] + c[2][0] + c[3][0]) * 0.25 * TILE;
      const cy = (c[0][1] + c[1][1] + c[2][1] + c[3][1]) * 0.25 * TILE;
      // Align to the stall's long axis, nosing toward the stall front edge
      // (corners 0-1). H1035: consistent orientation — the earlier random 180°
      // flip made car-sized rows read as a jumble.
      const fx = (c[0][0] + c[1][0]) * 0.5, fy = (c[0][1] + c[1][1]) * 0.5;
      const bx = (c[2][0] + c[3][0]) * 0.5, by = (c[2][1] + c[3][1]) * 0.5;
      const angle = Math.atan2(fy - by, fx - bx);
      PARKED_CARS.push({ id, name: CAR_CATALOG[id].name, x: cx, y: cy, angle });
    }
  }
}
