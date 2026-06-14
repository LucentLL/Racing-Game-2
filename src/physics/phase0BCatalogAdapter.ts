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
import { GT4_SPECS, type GT4Spec } from '@/config/cars/gt4Database';
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

/** Per-drivetrain base turn rate (rad/s) — the starting point of
 *  the turnR derivation. FF cars get the highest baseline (3.2)
 *  because front-wheel drive doesn't fight the rear axle for
 *  rotation authority; 4WD next (2.8); MR / RR / FR lower (rear-
 *  bias rotates with slip, not steering input).
 *
 *  Matches monolith
 *  `drv==='FF'?3.2:drv==='4WD'?2.8:drv==='MR'?3.0:drv==='RR'?2.7:2.6`
 *  at L7436. */
const BASE_TURN_BY_DRIVETRAIN: Record<Drivetrain, number> = {
  FF: 3.2,
  '4WD': 2.8,
  MR: 3.0,
  RR: 2.7,
  FR: 2.6,
};

/** Bike turnRate by mass bracket. The monolith's
 *  `isBike?(kg>250?3.2:3.8)` at L7437 — heavier sport-touring bikes
 *  (>250 kg) get a tighter 3.2; lighter sport bikes (<250 kg) get
 *  3.8. No GT4-spec inputs feed the bike branch; the per-car
 *  tuning lives entirely in the bike-lean chain. */
const BIKE_TURN_RATE_HEAVY = 3.2;
const BIKE_TURN_RATE_LIGHT = 3.8;
const BIKE_HEAVY_MASS_THRESHOLD_KG = 250;

/** Reference wheelbase (mm) for the wbFactor normalization.
 *  2500 mm ≈ Honda Civic / Toyota Corolla. The monolith's
 *  `wbFactor = 2500 / max(1800, wb)` produces 1.0 for the
 *  reference, > 1 for shorter (sharper turning), and < 1 for
 *  longer (more stable). The 1800 mm floor prevents
 *  unreasonably-tight turning on tiny kei cars or three-wheel
 *  vehicles. Matches monolith L7423-L7425. */
const WB_FACTOR_REF_MM = 2500;
const WB_FACTOR_MIN_MM = 1800;

/** Reference yaw radius for the yawFactor normalization. 25 is
 *  the "average car" tuning; lower spec.yaw → larger yawFactor
 *  → more rotation authority. The 12 floor prevents unphysically-
 *  tight rotation. Matches monolith
 *  `25 / Math.max(12, spec.yaw)` at L7427. */
const YAW_FACTOR_REF = 25;
const YAW_FACTOR_MIN = 12;

/** Reference tire tread width (mm) for the tireGripAvg
 *  normalization. 1450 mm is the average-car tire footprint;
 *  wider gets up to the 1.15× ceiling (the monolith caps each axle
 *  at 1.3 before averaging). Matches monolith
 *  `Math.min(1.3, spec.trF / 1450)` at L7431-L7432. */
const TIRE_GRIP_REF_MM = 1450;
const TIRE_GRIP_PER_AXLE_CAP = 1.3;
const TIRE_GRIP_TOTAL_CAP = 1.15;

/** Reference chassis length (mm) for the yawInertia normalization.
 *  4200 mm ≈ typical sedan length. Longer chassis = larger
 *  yawInertia = harder to rotate. The 0.85 floor prevents very-
 *  short chassis (sport coupes) from producing unphysical yaw
 *  authority. Matches monolith L7415 + L7437. */
const YAW_INERTIA_REF_MM = 4200;
const YAW_INERTIA_MIN = 0.85;

/** Reference suspension stiffness sum for the suspTurnMult
 *  normalization. Stock springs at 3.0/3.0 produce the 0.85 floor;
 *  stiff race springs at 10/10 hit the 1.2 ceiling. Matches
 *  monolith `Math.min(1.2, Math.max(0.85, (suspStiffF+suspStiffR)/8))`
 *  at L7390. */
const SUSP_TURN_MULT_DIVISOR = 8;
const SUSP_TURN_MULT_MIN = 0.85;
const SUSP_TURN_MULT_MAX = 1.2;
const SUSP_STIFF_DEFAULT = 3.0;

/** Per-axle grip baseline. spec.gF / spec.gR in the GT4 table
 *  range 75-110 (100 = baseline); dividing by 100 lands the value
 *  in [0.75, 1.10] for the multiplicative chain. Default 1.0 when
 *  no GT4 spec is available. Matches monolith
 *  `spec.gF/100` / `spec.gR/100` at L7419-L7420. */
const GRIP_BASE_DIVISOR = 100;

/** Compute the per-car turn rate (rad/s) — the per-frame peak yaw
 *  authority the upstream steering chain ([[computeDesiredYawRate]])
 *  multiplies by steerInputEff to produce pAngVel. Replaces the
 *  DEFAULT_TURN_RATE constant in phase0BAdapter.ts.
 *
 *  THREE-STAGE DERIVATION (1:1 with monolith L7390-L7437):
 *    1. Per-drivetrain base (FF 3.2, 4WD 2.8, MR 3.0, RR 2.7, FR 2.6)
 *    2. Six GT4-spec multipliers (wb / grip / yaw / tireGrip / susp /
 *       chassisLength inertia) — each documented in its own constant
 *    3. Bike override: kg>250 → 3.2; else 3.8 (bikes don't use the
 *       GT4 chain — their turnRate is mass-bracket-driven)
 *
 *  FORMULA (cars):
 *    turnR = baseTurn × wbFactor × gripAvg × yawFactor
 *            × min(1.15, tireGripAvg) × suspTurnMult
 *            / max(0.85, yawInertia)
 *
 *  WHEN spec IS UNDEFINED (no GT4 row): every multiplier collapses
 *  to its default-1.0-ish value (wbFactor 1.0, gripAvg 1.0,
 *  yawFactor 1.0, tireGripAvg 1.0), except suspTurnMult which
 *  hits its 0.85 floor (stock 3.0/3.0 springs / 8 = 0.75 → clamped
 *  to 0.85) and yawInertia which is 4200/4200 = 1.0. Result:
 *  turnR = baseTurn × 0.85. That matches the monolith's no-spec
 *  fallback exactly.
 *
 *  Pure function. Called once per frame by the runtime adapter
 *  ([[runPhase0BTick]]); cheap enough not to warrant per-car
 *  memoization at typical frame rates.
 *
 *  Ported 1:1 from monolith L7390-L7437 (the suspTurnMult through
 *  turnR derivation block in the CARS-build pipeline). */
export function computeCarTurnRate(
  car: CatalogCar,
  spec: GT4Spec | undefined,
): number {
  if (car.isBike) {
    return car.kg > BIKE_HEAVY_MASS_THRESHOLD_KG
      ? BIKE_TURN_RATE_HEAVY
      : BIKE_TURN_RATE_LIGHT;
  }
  const baseTurn = BASE_TURN_BY_DRIVETRAIN[car.drv as Drivetrain] ?? 2.6;

  // GT4-spec-derived intermediates (defaults when spec is absent).
  const wb = spec?.wb ?? WB_FACTOR_REF_MM;
  const wbFactor = WB_FACTOR_REF_MM / Math.max(WB_FACTOR_MIN_MM, wb);

  const gF = spec ? spec.gF / GRIP_BASE_DIVISOR : 1.0;
  const gR = spec ? spec.gR / GRIP_BASE_DIVISOR : 1.0;
  const gripAvg = (gF + gR) / 2;

  const yawFactor = spec
    ? YAW_FACTOR_REF / Math.max(YAW_FACTOR_MIN, spec.yaw)
    : 1.0;

  const tireGripF = spec
    ? Math.min(TIRE_GRIP_PER_AXLE_CAP, spec.trF / TIRE_GRIP_REF_MM)
    : 1.0;
  const tireGripR = spec
    ? Math.min(TIRE_GRIP_PER_AXLE_CAP, spec.trR / TIRE_GRIP_REF_MM)
    : 1.0;
  const tireGripAvg = (tireGripF + tireGripR) / 2;

  let suspStiffF = SUSP_STIFF_DEFAULT;
  let suspStiffR = SUSP_STIFF_DEFAULT;
  if (spec && spec.susp.length >= 16) {
    suspStiffF = spec.susp[2] || SUSP_STIFF_DEFAULT;
    suspStiffR = spec.susp[3] || SUSP_STIFF_DEFAULT;
  }
  const suspTurnMult = Math.min(
    SUSP_TURN_MULT_MAX,
    Math.max(SUSP_TURN_MULT_MIN, (suspStiffF + suspStiffR) / SUSP_TURN_MULT_DIVISOR),
  );

  const chassisL = spec?.lng ?? YAW_INERTIA_REF_MM;
  const yawInertia = chassisL / YAW_INERTIA_REF_MM;

  // H882: SUSPENSION upgrade — a direct turn-rate multiplier carried on the
  // effective car, applied AFTER the stock susp clamp so stages stay
  // progressive (stock cars sit at the suspTurnMult floor). 1.0 when stock.
  const suspUpgrade = car.suspTurnBonus ?? 1;

  return (
    baseTurn
    * wbFactor
    * gripAvg
    * yawFactor
    * Math.min(TIRE_GRIP_TOTAL_CAP, tireGripAvg)
    * suspTurnMult
    * suspUpgrade
    / Math.max(YAW_INERTIA_MIN, yawInertia)
  );
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
