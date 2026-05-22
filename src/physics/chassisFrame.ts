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

/** Game-unit to meters scale: 1 game unit = 0.2056 m. Established
 *  by the world-scale calibration done in early monolith versions
 *  (road widths, car sizes calibrated against real-world refs).
 *
 *  Many physics formulas need to convert between game units and
 *  real-world units. Centralized here so callers can use the
 *  named constant rather than repeating the literal magic
 *  number. */
export const METERS_PER_GAME_UNIT = 0.2056;

/** Square-game-units per square-meter conversion: (1 / 0.2056)²
 *  ≈ 23.67. Used when the input formula yields a result in m²
 *  (a moment-of-inertia integral) but the rest of the code
 *  operates in gu². The conversion is exact mathematically;
 *  the literal 23.67 in the monolith is the rounded version
 *  used for arithmetic.
 *
 *  Matches monolith `_GU2_PER_M2 = 23.67` at L25171. */
export const GU2_PER_M2 = 23.67;

/** Feel-calibration factor on the textbook moment-of-inertia
 *  formula. The textbook value `m × (L² + W²) / 12` (a uniform
 *  rectangular slab about its vertical centroid) is physically
 *  correct but produces a magnitude that's slightly too high
 *  vs. the prior placeholder. 0.55 multiplies it down so a
 *  typical road car (~4.25 m × ~1.7 m) lands near the prior
 *  placeholder magnitude (mass × Lwb² × 0.12), keeping steering
 *  response unchanged at the average car while the formula
 *  correctly captures width effects for square / long-narrow
 *  outliers.
 *
 *  Phase 7 (v8.59) is correctness housekeeping more than a
 *  feel-changer — the difference is small for most cars; the
 *  point is that wide cars and narrow cars now feel
 *  differently in yaw reversals.
 *
 *  Matches monolith `_k_feel = 0.55` at L25172. */
export const CHASSIS_I_FEEL_FACTOR = 0.55;

/** Fallback yaw-inertia coefficient for the Phase 0B placeholder
 *  formula (when GT4 spec lacks `lng` and `wid` or the chassisI
 *  setting is disabled):
 *
 *    I_fallback = mass × wheelbase² × 0.12
 *
 *  This was the formula before Phase 7 — uses only length (via
 *  wheelbase) and produces a sensible single-number magnitude
 *  per car. Preserved as the fallback so disabling chassisI in
 *  settings still gives a working integrator.
 *
 *  Matches monolith `I = mass*Lwb*Lwb*0.12` at L25176. */
export const CHASSIS_I_FALLBACK_COEFF = 0.12;

/** Compute the yaw moment of inertia (I) about the vertical CG
 *  axis — what resists pYawRate changes in the Phase 0B
 *  integrator's `dω/dt = τ / I` step.
 *
 *  TWO PATHS, selected by `chassisIActive` AND data availability:
 *
 *  PATH 1 — Phase 7 (v8.59) chassis-dimension-based formula:
 *    L = gt4Lng / 1000      [mm → m]
 *    W = gt4Wid / 1000
 *    I_kgM2 = mass × (L² + W²) / 12         [textbook slab]
 *    I_guUnits = I_kgM2 × GU2_PER_M2 × CHASSIS_I_FEEL_FACTOR
 *
 *    Engages when chassisIActive AND gt4Lng AND gt4Wid are all
 *    truthy. Captures both length AND width — wide-but-short
 *    cars (Abarth A112) gain yaw inertia vs. the old formula;
 *    long-narrow cars lose a tiny bit; dramatic width outliers
 *    (Cizeta V16T, CLK-GTR ~1950-2000mm) feel a touch more
 *    planted in yaw reversals.
 *
 *  PATH 2 — Phase 0B placeholder fallback (pre-v8.59):
 *    I = mass × wheelbase² × 0.12
 *
 *    Engages when chassisIActive is false OR length/width data
 *    is missing. Length-only (via wheelbase ≈ 65 % of body
 *    length) — wide cars and narrow cars feel identical.
 *
 *  Phase 7 is correctness housekeeping more than a feel-changer:
 *  the difference is small for most cars and the k_feel factor
 *  (0.55) was tuned so a typical road car lands near the prior
 *  placeholder magnitude. Setting `chassisIActive = false`
 *  console-flips back to the placeholder.
 *
 *  INPUTS:
 *    mass             chassis mass in kg (post-[[sanitizeChassisMass]])
 *    wheelbase        Lwb in game units
 *    gt4Lng           cc.gt4.lng — body length in mm; undefined
 *                     forces the fallback path
 *    gt4Wid           cc.gt4.wid — body width in mm; undefined
 *                     forces the fallback path
 *    chassisIActive   LIFE.gameplaySettings.chassisI !== false
 *                     (default true)
 *
 *  Returns I in game-unit space (kg × gu²). Units may look
 *  weird but consistency with the rest of the integrator's
 *  mixed gu/kg system is what matters — every force, torque,
 *  and angular velocity passes through the same conversion
 *  conventions.
 *
 *  Ported 1:1 from monolith L25165-L25177 (the Phase 7 yaw-
 *  inertia block in the Phase 0B integrator setup). */
export function computeChassisYawInertia(
  mass: number,
  wheelbase: number,
  gt4Lng: number | undefined,
  gt4Wid: number | undefined,
  chassisIActive: boolean,
): number {
  if (chassisIActive && gt4Lng && gt4Wid) {
    const lngM = gt4Lng / 1000;
    const widM = gt4Wid / 1000;
    const IkgM2 = mass * (lngM * lngM + widM * widM) / 12;
    return IkgM2 * GU2_PER_M2 * CHASSIS_I_FEEL_FACTOR;
  }
  return mass * wheelbase * wheelbase * CHASSIS_I_FALLBACK_COEFF;
}

/** Gravitational acceleration in game units per second squared
 *  (9.81 m/s² / 0.2056 m/gu ≈ 47.71 gu/s²). Used in normal-load
 *  formulas (Fz = m × g) and downforce normalization (scaling
 *  aerodynamic kg-equivalents back into force units).
 *
 *  Matches monolith `g_gu = 9.81 / 0.2056` at L25179. */
export const GRAVITY_GU = 9.81 / METERS_PER_GAME_UNIT;

/** Static axle normal-load tuple from [[computeStaticNormalLoads]]:
 *    Fz_F + Fz_R = mass × g  (by construction; static loads sum
 *                             to the chassis weight) */
export interface StaticNormalLoads {
  Fz_F: number;
  Fz_R: number;
}

/** Compute the STATIC (no-acceleration, no-aero) axle normal
 *  loads. These are the load distributions you'd measure with
 *  the car parked on a level surface — the basis on which
 *  downforce (Phase 6) and dynamic weight transfer (Phase 3) are
 *  added later in the integrator's load-buildup sequence.
 *
 *  FORMULA (1:1 with monolith):
 *    Fz_F = mass × g × wdF        [front load proportional to wdF]
 *    Fz_R = mass × g × (1 - wdF)
 *
 *  PROPERTIES:
 *  - Fz_F + Fz_R = mass × g (loads sum to weight; no levitation).
 *  - Front-heavy car (wdF > 0.5): Fz_F > Fz_R, more grip
 *    available at the front in the friction-circle budget.
 *  - Rear-heavy (wdF < 0.5): reversed.
 *  - g is in game units (GRAVITY_GU ≈ 47.71 gu/s²) so the
 *    result is in `kg × gu/s²` — game-unit force, consistent
 *    with the rest of the integrator's mixed gu/kg system.
 *
 *  RELATIONSHIP TO LEVER ARMS: notice the LOAD scales with wdF
 *  but the LEVER ARM from CG ([[computeAxleLeverArms]]) scales
 *  with (1 - wdF). Large load × short lever = small load × long
 *  lever — the static-moment balance around CG (a heavyweight
 *  near a short fulcrum balances a lightweight on a long one).
 *
 *  Caller will ADD onto these loads in two later steps:
 *    1. Downforce (Phase 6): F_df = df × g × (v / v_ref)²
 *       — quadratic in speed, pushes both axles toward ground
 *    2. Weight transfer (Phase 3): ΔFz = -mass × a_long ×
 *                                         h_cg / Lwb
 *       — proportional to longitudinal accel; weight shifts
 *       toward whichever end the car is "leaning into"
 *
 *  Ported 1:1 from monolith L25180-L25181 (the static normal-
 *  load pair in the Phase 0B integrator setup, between yaw
 *  inertia and downforce). */
export function computeStaticNormalLoads(
  mass: number,
  wdF: number,
): StaticNormalLoads {
  const Fz_F = mass * GRAVITY_GU * wdF;
  const Fz_R = mass * GRAVITY_GU * (1 - wdF);
  return { Fz_F, Fz_R };
}

/** Reference speed for the downforce formula, in game units per
 *  second. 270 gu/s = 55.5 m/s = 200 km/h ≈ 124 mph. At this
 *  speed, an axle's downforce equals exactly its `df` kg-
 *  equivalent value as added normal load. Below this speed
 *  downforce is smaller (quadratic falloff); above, it's bigger.
 *
 *  WHY 200 km/h: it's a commonly-cited reference in real-world
 *  GT car aero specs (downforce-at-200-km/h is a standard data
 *  point in manufacturer figures), so the calibration anchors
 *  cleanly to published numbers.
 *
 *  Matches monolith `_vRefGU = 270` at L25195. */
export const DOWNFORCE_V_REF_GU = 270;

/** Apply aerodynamic downforce to a pair of axle normal loads.
 *  Adds quadratically-with-speed kg-equivalent of normal force
 *  to each axle:
 *
 *    F_df_F = df[0] × g × (v / v_ref)²
 *    F_df_R = df[1] × g × (v / v_ref)²
 *
 *  REFERENCE POINTS (df values from the GT4 database):
 *    Road car  df=[30, 30]   @ 200 km/h → +5% grip per axle
 *    GT car    df=[38, 53]   @ 250 km/h → +11%F / +15%R
 *    LMP car   df=[63, 88]   @ 300 km/h → +32%F / +43%R
 *
 *  WHY QUADRATIC IN SPEED: aerodynamic forces scale with v²
 *  (drag, lift, downforce — all proportional to the square of
 *  airspeed). The (v / v_ref)² normalization keeps the formula
 *  in dimensionless units relative to the reference point.
 *
 *  EFFECT IN-GAME: mostly visible in the friction-circle budget
 *  (lateral grip). Longitudinal traction isn't Fz-gated in our
 *  drivetrain model, so downforce shows up under CORNERING and
 *  when braking-in-corner — exactly where real downforce wins
 *  matter. The split between F and R df values models aero
 *  balance: a rear-biased df spread induces understeer-relief
 *  at speed (rear bites first).
 *
 *  Console-flippable via gameplaySettings.downforce. When
 *  disabled OR df spec is missing, the function returns the
 *  input loads unchanged.
 *
 *  INPUTS:
 *    loads          current {Fz_F, Fz_R} from
 *                   [[computeStaticNormalLoads]]; not mutated
 *    df             [dfF, dfR] from cc.gt4.df, or undefined
 *    pSpeed         |player speed| in game units / sec
 *    dfActive       LIFE.gameplaySettings.downforce !== false
 *                   (default true)
 *
 *  Returns the new {Fz_F, Fz_R} with downforce added; if df is
 *  missing or dfActive is false, returns the input loads
 *  unchanged.
 *
 *  Ported 1:1 from monolith L25193-L25198 (the Phase 6
 *  downforce block in the Phase 0B integrator setup). */
export function applyAerodynamicDownforce(
  loads: StaticNormalLoads,
  df: readonly number[] | undefined,
  pSpeed: number,
  dfActive: boolean,
): StaticNormalLoads {
  if (!dfActive || !df) return loads;
  const vSqNorm = (pSpeed * pSpeed) / (DOWNFORCE_V_REF_GU * DOWNFORCE_V_REF_GU);
  const dfF = df[0] || 0;
  const dfR = df[1] || 0;
  return {
    Fz_F: loads.Fz_F + dfF * GRAVITY_GU * vSqNorm,
    Fz_R: loads.Fz_R + dfR * GRAVITY_GU * vSqNorm,
  };
}
