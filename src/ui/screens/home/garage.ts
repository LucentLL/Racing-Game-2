/**
 * Garage tab — per-vehicle fleet manager.
 *
 * v8.99.122.44 replaced the single-active-car readout with a scrollable
 * list of every owned car. Each row shows top-down sprite + name +
 * condition stats + (when applicable) loan/fault tail. Tapping a row
 * expands an action panel for THAT car — no need to switch the active
 * vehicle first.
 *
 * Three sub-views dispatched off LIFE._garageView (v8.98.47 fullscreen
 * dispatch — sub-views take over the entire tab area, not a drawer):
 *   - 'specs'   → drawGarageSpecs   (fleet-normalized gauges per car)
 *   - 'repairs' → drawGarageRepairs (per-car fault list + repair venues)
 *   - 'parts'   → drawGarageParts   (parts inventory + WORK IN PROGRESS)
 *   - undefined → drawHomeGarage    (the per-vehicle list itself)
 *
 * Stale-selection guard: drops LIFE._garageSelCarId if that car was sold
 * or lost since last frame.
 *
 * Ported from monolith L48176 (drawHomeGarage), L48361 (drawGarageSpecs),
 * L48548 (drawGarageRepairs), L48642 (drawGarageParts).
 *
 * SCAFFOLD status: type contract + dispatcher + sub-view entry points
 * stubbed with TODO line refs.
 */

/** Car ID — bare string key into CARS map. */
type CarId = string;

/** Active sub-view of the garage tab. */
export type GarageView = 'list' | 'specs' | 'repairs' | 'parts';

/** Per-frame inputs for the garage list (the default sub-view). */
export interface GarageListOpts {
  /** Player's owned-car IDs in display order. */
  ownedCars: CarId[];
  /** Currently expanded car (action panel showing). null = collapsed list. */
  selectedCarId: CarId | null;
  /** Active newspaper ads (rendered as a tail section under the cars). */
  carAds: Array<{ carId: CarId; offers: unknown[] }>;
  /** Scroll offset (LIFE._scrollY — shared per-tab). */
  scrollY: number;
  /** Canvas internal width / height. */
  GW: number;
  GH_BASE: number;
  /** Bottom strip reserved for the BACK button (BACK_ZONE constant). */
  BACK_ZONE: number;
}

/** Per-frame inputs for the specs sub-view. The car under inspection is
 *  whatever was last tapped via SPECS — held in LIFE._garageSpecsCarId. */
export interface GarageSpecsOpts {
  carId: CarId;
  /** Canvas internal width / height. */
  GW: number;
  GH_BASE: number;
  BACK_ZONE: number;
}

/** Per-frame inputs for the repairs sub-view. */
export interface GarageRepairsOpts {
  carId: CarId;
  GW: number;
  GH_BASE: number;
  BACK_ZONE: number;
}

/** Per-frame inputs for the parts sub-view. */
export interface GaragePartsOpts {
  carId: CarId;
  GW: number;
  GH_BASE: number;
  BACK_ZONE: number;
}

/** Top-level garage entry — dispatches to one of the four sub-views per
 *  the GarageView discriminator. TODO(D29-followup): port from L48176-
 *  end of garage list. */
export function drawHomeGarage(
  _ctx: CanvasRenderingContext2D,
  _view: GarageView,
  _listOpts: GarageListOpts,
  _specsOpts: GarageSpecsOpts | null,
  _repairsOpts: GarageRepairsOpts | null,
  _partsOpts: GaragePartsOpts | null,
): void {
  // TODO: L48176+. Dispatcher: if view==='specs' → drawGarageSpecs,
  // if 'repairs' → drawGarageRepairs, if 'parts' → drawGarageParts,
  // else draw the per-vehicle scrollable list (default).
}

/** Specs sub-view — fleet-normalized gauges (top speed / hp / accel /
 *  handling / braking) for one car. Driver/trans/gears as text rows
 *  below. TODO(D29-followup): port from L48361. */
export function drawGarageSpecs(
  _ctx: CanvasRenderingContext2D,
  _opts: GarageSpecsOpts,
): void {
  // TODO: L48361.
}

/** Repairs sub-view — per-car fault list with repair-venue selection.
 *  TODO(D29-followup): port from L48548. */
export function drawGarageRepairs(
  _ctx: CanvasRenderingContext2D,
  _opts: GarageRepairsOpts,
): void {
  // TODO: L48548.
}

/** Parts sub-view — parts inventory + WORK IN PROGRESS list (orders
 *  placed via DIY delivery that are en route).
 *  TODO(D29-followup): port from L48642. */
export function drawGarageParts(
  _ctx: CanvasRenderingContext2D,
  _opts: GaragePartsOpts,
): void {
  // TODO: L48642.
}
