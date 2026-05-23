/**
 * Catalog → Phase 0B car-spec adapter.
 *
 * Translates a [[CatalogCar]] (the per-car derived record assembled
 * from GT4_DB + GT4_SPECS at catalog build time) into the
 * [[Phase0BCarSpec]] shape the integrator consumes. Pure function;
 * no state, no side effects.
 *
 * H498: this is one of five adapter ports that together unblock the
 * Phase 0B runtime cutover (H502). The integrator's car-spec
 * interface is intentionally minimal — only the fields the
 * integrator's primitives actually read — so the adapter is
 * mechanically a field-by-field projection with one extra
 * transformation (parsing tire-width millimeters out of the GT4
 * `tsF`/`tsR` tire-size strings).
 *
 * The integrator's `gt4?` sub-object is OPTIONAL — when GT4_SPECS
 * doesn't have a row for this car (rare; covers a few catalog
 * entries from edge sources), the adapter passes undefined, and the
 * integrator's chassis-frame / tire-coefficient primitives fall
 * through to their established defaults (matches monolith fallback
 * behavior).
 */

import type { CatalogCar } from '@/config/cars/catalog';
import { GT4_SPECS } from '@/config/cars/gt4Database';
import type { Drivetrain } from './steering';
import type { Phase0BCarSpec } from './phase0BIntegrator';

/** Default per-car power scaling. The monolith reads `cc.powerMult`
 *  which defaults to 1.0 when unset (engine mods + fuel quality
 *  multiply it; the unmodified baseline is 1.0). The catalog
 *  doesn't currently surface per-car powerMult overrides, so the
 *  adapter passes 1.0 unconditionally. */
const DEFAULT_POWER_MULT = 1.0;

/** Default per-car traction-control scaling. The monolith reads
 *  `cc.tractionMult` which defaults to 1.0. Same reasoning as
 *  [[DEFAULT_POWER_MULT]]. */
const DEFAULT_TRACTION_MULT = 1.0;

/** Default tire width in millimeters when the GT4 tire-size string
 *  is absent or unparseable. Matches monolith fallback
 *  `(parseInt(spec.tsF.split('/')[0])||225):225` at L7554. 225 mm
 *  is a typical mid-size sedan tire — a sensible "I don't know,
 *  pretend it's average" pick that keeps the friction-circle math
 *  finite for cars without GT4 rows. */
const DEFAULT_TIRE_WIDTH_MM = 225;

/** Parse the tire-width millimeters from a GT4 tire-size string.
 *  Tire-size strings follow the standard format
 *  `WWW/AAR_DD` (e.g. `225/45R17`, `205/50 R15`) where WWW is the
 *  section width in mm. The monolith's `parseInt(spec.tsF.split(
 *  '/')[0])` extracts that first number.
 *
 *  Returns [[DEFAULT_TIRE_WIDTH_MM]] (225) when the input is
 *  undefined OR when parseInt fails to extract a finite number.
 *  Matches monolith fallback chain at L7554-L7555.
 *
 *  Exported in case other adapters need the same parse (the
 *  monolith inlines this in CARS build + a handful of other
 *  places; centralizing it lets future ports import a single
 *  source of truth). */
export function parseTireWidthMm(tireSizeSpec: string | undefined): number {
  if (!tireSizeSpec) return DEFAULT_TIRE_WIDTH_MM;
  const head = tireSizeSpec.split('/')[0];
  const parsed = parseInt(head, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_TIRE_WIDTH_MM;
}

/** Translate a catalog entry into the per-car spec the Phase 0B
 *  integrator consumes.
 *
 *  FIELD MAPPING:
 *    mass         ← car.kg
 *    bodyLength   ← car.size[0]               (game-unit body length)
 *    powerMult    ← 1.0                       (default, see above)
 *    tractionMult ← 1.0                       (default, see above)
 *    gearSpeeds   ← car.gearSpeeds            (length gears+1, sentinel at index 0)
 *    gears        ← car.gears
 *    idleRPM      ← car.idleRPM
 *    redline      ← car.redline
 *    topSpeed     ← car.topSpeed              (game units / second)
 *    hp           ← car.hp
 *    drivetrain   ← car.drv as Drivetrain     (catalog stores as string)
 *    torqueCurve  ← { rpms: car.tcRPMs, norms: car.tcNorm }
 *    isBike       ← car.isBike
 *    isGt4        ← true iff a GT4_SPECS row exists for this car name
 *
 *  GT4 SUB-OBJECT (optional — undefined when GT4_SPECS lookup misses):
 *    gt4.wdF      ← spec.wdF                  (front weight pct)
 *    gt4.lng      ← spec.lng                  (body length mm)
 *    gt4.wid      ← spec.wid                  (body width mm)
 *    gt4.df       ← spec.df                   ([dfF, dfR] downforce)
 *    gt4.susp     ← spec.susp                 (16-element suspension)
 *    gt4.twF      ← parseTireWidthMm(spec.tsF)
 *    gt4.twR      ← parseTireWidthMm(spec.tsR)
 *    gt4.lsd      ← spec.lsd                  ([init/accel/decel × F/R])
 *    gt4.pIF      ← spec.pIF                  (front power input share, 4WD)
 *    gt4.pIR      ← spec.pIR                  (rear power input share, 4WD)
 *    gt4.canSC    ← spec.canSC                (supercharger-eligible)
 *
 *  WHY THE GT4 SUB-OBJECT IS OPTIONAL: not every catalog car has a
 *  matching GT4_SPECS row (the catalog includes some edge sources
 *  the GT4 database doesn't cover). The integrator's chassis-frame /
 *  weight-transfer / tire-coefficient primitives all use
 *  `spec.gt4?.fieldName` chains and fall through to defaults when
 *  the lookup misses — that matches the monolith's
 *  `cc.gt4 && cc.gt4.X` guards at L7554 and throughout the Phase
 *  0B branch.
 *
 *  Pure function. Allocates a new object each call; cheap, no
 *  caching warranted at typical call frequencies (once per frame
 *  when the runtime cutover lands — and only when the integrator
 *  branch is active).
 *
 *  Composed monolith range: L7327-L7401 (the CARS-build mapping
 *  that this adapter replaces in the modular tree) — with the
 *  fields the Phase 0B integrator specifically reads selected
 *  through. */
export function buildPhase0BCarSpec(car: CatalogCar): Phase0BCarSpec {
  const spec = GT4_SPECS[car.name];
  return {
    mass: car.kg,
    bodyLength: car.size[0],
    powerMult: DEFAULT_POWER_MULT,
    tractionMult: DEFAULT_TRACTION_MULT,
    gearSpeeds: car.gearSpeeds,
    gears: car.gears,
    idleRPM: car.idleRPM,
    redline: car.redline,
    topSpeed: car.topSpeed,
    hp: car.hp,
    drivetrain: car.drv as Drivetrain,
    torqueCurve: {
      rpms: car.tcRPMs,
      norms: car.tcNorm,
    },
    gt4: spec
      ? {
          wdF: spec.wdF,
          lng: spec.lng,
          wid: spec.wid,
          df: spec.df,
          susp: spec.susp,
          twF: parseTireWidthMm(spec.tsF),
          twR: parseTireWidthMm(spec.tsR),
          lsd: spec.lsd,
          pIF: spec.pIF,
          pIR: spec.pIR,
          canSC: spec.canSC,
        }
      : undefined,
    isBike: car.isBike,
    isGt4: spec !== undefined,
  };
}
