/**
 * Phase 3 dynamic longitudinal weight transfer (v8.58).
 *
 * Real suspension doesn't transfer load instantly — the chassis
 * pitches forward under braking, squats under throttle, and the
 * load shift takes a fraction of a second to play out. This
 * module models that as a first-order low-pass on a target load-
 * transfer value derived from the longitudinal acceleration:
 *
 *   transferTarget = -mass × a_long × h_cg / wheelbase
 *   pFzTransfer   += (target - pFzTransfer) × (dt / tau)
 *   Fz_F          += pFzTransfer
 *   Fz_R          -= pFzTransfer
 *
 * Where:
 *   +a_long (throttle)  → weight comes OFF front → transfer
 *                          negative → rear loads up
 *   -a_long (braking)   → weight goes ONTO front → transfer
 *                          positive → front loads up
 *
 * The time constant tau is derived from the car's GT4 suspension
 * spring-rate data (susp[2-3] gives the cleanest road-vs-race
 * spread). Stiffer springs → faster transfer → less pitch.
 *
 * Console-flippable via gameplaySettings.suspension. When
 * disabled, static loads are used unchanged.
 *
 * Monolith source: inside update() at L25199-L25249.
 */

/** Default suspension time constant when GT4 spec lacks susp
 *  data. 0.18 s — a mid-range road-car value that produces
 *  visible but not exaggerated pitch under braking/throttle.
 *  Used when the spring-rate proxy can't be computed.
 *
 *  Matches monolith `let tau = 0.18` at L25232. */
export const SUSPENSION_TAU_DEFAULT = 0.18;

/** Stiffest-suspension lower bound on tau, in seconds. A full-
 *  race car (susp[2-3] ≈ 20) would compute below this; the floor
 *  caps it at 0.06 s so the load transfer doesn't become
 *  arbitrarily fast and create integrator instability.
 *
 *  Matches monolith `Math.max(0.06, ...)` at L25235. */
export const SUSPENSION_TAU_MIN = 0.06;

/** Softest-suspension upper bound on tau, in seconds. Caps soft
 *  road cars at 0.25 s so even a luxury sedan with very soft
 *  springs has a load transfer that fully plays out in under a
 *  second.
 *
 *  Matches monolith `Math.min(0.25, ...)` at L25235. */
export const SUSPENSION_TAU_MAX = 0.25;

/** Tau intercept — the tau value at spring-rate proxy = 0. The
 *  linear formula is `tau = 0.22 - springProxy * 0.008`, which
 *  at proxy=0 yields 0.22 (just above the default). The floor
 *  and ceiling above clamp the actual return into the [0.06,
 *  0.25] range.
 *
 *  Matches monolith `0.22` at L25235. */
export const SUSPENSION_TAU_INTERCEPT = 0.22;

/** Tau slope per unit of spring-rate proxy. Linear formula:
 *  `tau = 0.22 - springProxy × 0.008`. Stiffer springs (higher
 *  proxy) reduce tau (faster transfer); softer springs (lower
 *  proxy) increase tau (slower transfer).
 *
 *  WHY 0.008: empirically tuned so a typical road car (proxy
 *  ≈ 2-4) yields tau ≈ 0.20-0.19 s, while a full-race car
 *  (proxy ≈ 20) yields tau ≈ 0.06 s (the floor). The slope
 *  covers the full spread of cars in the GT4 fleet.
 *
 *  Matches monolith `0.008` at L25235. */
export const SUSPENSION_TAU_SLOPE = 0.008;

/** Compute the suspension time constant (tau) from the GT4 spec's
 *  spring-rate data. Stiffer springs produce faster load transfer
 *  (smaller tau); softer springs produce slower transfer (larger
 *  tau). Used as the time-constant of a first-order low-pass on
 *  the target load shift.
 *
 *  FORMULA (1:1 with monolith):
 *    if susp[2-3] data missing: tau = 0.18  [default]
 *    else:
 *      springProxy = (susp[2] + susp[3]) / 2
 *      tau = clamp(0.22 - springProxy × 0.008, 0.06, 0.25)
 *
 *  WHY susp[2-3]: per the GT4 spec docstring, susp[] is a 16-
 *  entry array where [2] and [3] are the "compression spring
 *  maximum" values for front and rear. They give the cleanest
 *  road-vs-race spread (~2-4 for road cars, ~20 for race cars),
 *  making them the best proxy for "how stiff is the suspension
 *  overall." Other susp[] entries are dampers, ride heights,
 *  etc. — less directly tied to load-transfer speed.
 *
 *  REQUIRES `susp.length >= 4` to access indices 2 and 3.
 *  Missing or short susp arrays fall back to the default tau.
 *
 *  INPUTS:
 *    gt4Susp     cc.gt4.susp from the GT4 spec; undefined or
 *                short arrays trigger the fallback.
 *
 *  Returns tau in seconds, clamped to [0.06, 0.25].
 *
 *  Ported 1:1 from monolith L25232-L25236 (the tau-from-spring-
 *  rate proxy block in the Phase 3 weight-transfer code). */
export function computeSuspensionTau(
  gt4Susp: readonly number[] | undefined,
): number {
  if (!gt4Susp || gt4Susp.length < 4) return SUSPENSION_TAU_DEFAULT;
  const springProxy = (gt4Susp[2] + gt4Susp[3]) * 0.5;
  const raw = SUSPENSION_TAU_INTERCEPT - springProxy * SUSPENSION_TAU_SLOPE;
  if (raw < SUSPENSION_TAU_MIN) return SUSPENSION_TAU_MIN;
  if (raw > SUSPENSION_TAU_MAX) return SUSPENSION_TAU_MAX;
  return raw;
}
