/**
 * Chassis frame setup — the physical-property derivations that
 * happen at the top of the Phase 0B force integrator before the
 * tire-force, friction-circle, and yaw-torque computations
 * begin.
 *
 * Centralizes the sanitizers (mass floor, weight-distribution
 * fallback) and the derived geometry (CG → axle lever arms,
 * yaw inertia, static normal loads) so each is a named function
 * with one source of truth.
 *
 * Monolith source: inside update() at L25135-L25181 + the
 * Phase-7 chassis-dimension yaw-inertia block at L25145-L25177.
 */

/** Minimum chassis mass in kg. Floors the input mass so a
 *  degenerate car config (mass missing or absurdly low) can't
 *  blow up the force integrator. 400 kg is below any reasonable
 *  road car — most cars in the GT4 database are 800-1800 kg —
 *  so the floor only engages on malformed input.
 *
 *  Matches monolith `Math.max(400, ...)` at L25136. */
export const CHASSIS_MASS_MIN = 400;

/** Default chassis mass in kg when the input is missing/0.
 *  1200 kg is a midsize-sedan archetype — defensive fallback
 *  that produces sensible behavior for cars whose config
 *  somehow lacks a mass field.
 *
 *  Matches monolith fallback `||1200` at L25136. */
export const CHASSIS_MASS_DEFAULT = 1200;

/** Sanitize a raw chassis-mass input: apply the default-when-
 *  missing fallback and then floor at the minimum.
 *
 *  FORMULA (1:1 with monolith):
 *    mass = max(400, rawMass || 1200)
 *
 *  OR-FALLBACK semantics: treats 0 and undefined identically.
 *  A real car never has mass exactly 0, so this collapse is
 *  benign and matches the monolith's `cc.mass||1200` idiom.
 *
 *  INPUTS:
 *    rawMass    CAR().mass — may be undefined or 0 if config
 *               is incomplete; the GT4 database always provides
 *               this, but defensive guard for partial configs.
 *
 *  Ported 1:1 from monolith L25136 (the mass line at the head
 *  of the Phase 0B integrator). */
export function sanitizeChassisMass(rawMass: number | undefined): number {
  return Math.max(CHASSIS_MASS_MIN, rawMass || CHASSIS_MASS_DEFAULT);
}

/** Default front-axle weight FRACTION (not percent) when the
 *  GT4 spec is missing the wdF field. 0.5 = 50/50 split, which
 *  is the neutral fallback that makes the integrator behave
 *  symmetrically when calibration data is absent.
 *
 *  Matches monolith fallback `:0.5` at L25139. */
export const DEFAULT_WEIGHT_DISTRIBUTION = 0.5;

/** Convert the GT4 spec's front-weight PERCENTAGE (e.g. 48,
 *  60) into a [0, 1] fraction usable by the rest of the
 *  integrator (e.g. 0.48, 0.60). Falls back to 50/50 split
 *  when the spec is missing.
 *
 *  FORMULA (1:1 with monolith):
 *    wdF = gt4WdF ? gt4WdF / 100 : 0.5
 *
 *  WDF SEMANTICS: front-axle FRACTION of total static weight.
 *  - wdF = 0.5  → 50/50, balanced
 *  - wdF > 0.5  → front-heavy (FF transverse engines, GT cars
 *                 with engine ahead of cockpit)
 *  - wdF < 0.5  → rear-heavy (mid/rear-engine, RR Porsches at
 *                 ~38-42 %, MR Ferraris at ~40-45 %)
 *
 *  Used downstream by:
 *  - Lever-arm distances `a` (CG → front axle) and `b` (CG →
 *    rear axle) — these are computed as Lwb*(1-wdF) and Lwb*wdF
 *    respectively. Front-heavy means small `a` (CG sits near
 *    front), large `b` (long distance to rear axle).
 *  - Static normal loads: Fz_F ∝ mass × g × wdF, Fz_R ∝
 *    mass × g × (1-wdF).
 *
 *  OR-FALLBACK semantics: treats 0 and undefined identically.
 *  A real car never has 0 weight on the front axle so the
 *  collapse is benign (and 0 would imply the car is doing a
 *  permanent wheelie, which is not a sane integrator input).
 *
 *  Ported 1:1 from monolith L25139 (the wdF normalization at
 *  the head of the Phase 0B integrator). */
export function computeWeightDistribution(gt4WdF: number | undefined): number {
  return gt4WdF ? gt4WdF / 100 : DEFAULT_WEIGHT_DISTRIBUTION;
}

/** Lever-arm result tuple from [[computeAxleLeverArms]]:
 *    a = distance from CG to FRONT axle
 *    b = distance from CG to REAR axle
 *    a + b = wheelbase  (by construction)
 *
 *  Names match the monolith and the Phase 0B integrator's
 *  yaw-torque equation τ = a × F_lat_F − b × F_lat_R. */
export interface AxleLeverArms {
  a: number;
  b: number;
}

/** Compute the CG-to-axle lever-arm distances from wheelbase
 *  and weight distribution. Used by the Phase 0B yaw-torque
 *  equation and the moment-arms for normal-load balance.
 *
 *  FORMULA (1:1 with monolith):
 *    a = Lwb × (1 - wdF)    [CG → FRONT axle]
 *    b = Lwb × wdF          [CG → REAR axle]
 *
 *  GEOMETRY (think of it as a moment-arm problem):
 *  The CG sits `wdF` FRACTION of wheelbase AHEAD of the rear
 *  axle. Equivalently, the CG sits `(1 - wdF)` fraction of
 *  wheelbase BEHIND the front axle.
 *
 *  - Front-heavy (wdF > 0.5): CG near front, so distance CG→front
 *    (a) is small; distance CG→rear (b) is large.
 *  - Rear-heavy (wdF < 0.5): CG near rear, so a is large, b small.
 *  - Balanced (wdF = 0.5): a = b = Lwb / 2.
 *
 *  WHY THE BACKWARDS-LOOKING SIGNS: the moment-arm of a force at
 *  the front axle is `a = CG → front` (perpendicular distance
 *  from rotation axis at CG to the applied force). For static-
 *  load distribution, the FORCE at the front axle counters the
 *  WEIGHT acting at the CG; moments balance when Fz_F × a =
 *  m × g × (CG-offset from front) — but the (1 - wdF) is the
 *  position offset, not the load. The literal balance is:
 *    Fz_F = mass × g × wdF      (load proportional to wdF)
 *    Fz_R = mass × g × (1 - wdF)
 *  while the lever arms are:
 *    a = Lwb × (1 - wdF)         (small a when front-heavy)
 *    b = Lwb × wdF               (large b when front-heavy)
 *  This pairing — large load × small lever, small load × large
 *  lever — is what keeps the static moment balanced around CG.
 *  Same conserved-moment relationship a heavyweight at the short
 *  end of a seesaw balances a lightweight at the long end.
 *
 *  Ported 1:1 from monolith L25143-L25144 (the lever-arm pair
 *  in the Phase 0B integrator setup). */
export function computeAxleLeverArms(
  wheelbase: number,
  wdF: number,
): AxleLeverArms {
  return {
    a: wheelbase * (1 - wdF),
    b: wheelbase * wdF,
  };
}
