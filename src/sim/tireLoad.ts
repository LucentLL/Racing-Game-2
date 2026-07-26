/**
 * H1250: TYRE GRIP UTILISATION — "how close are the tyres to letting go?"
 *
 * User report: "I don't feel or hear feedback from the tires when going
 * through turns. Low speed and high speed sound/feel the same. The tires
 * should screech when approaching grip limit before sliding."
 *
 * Both halves of that were true. The tyre audio's cornering branch required
 * `isDrifting && |slipAngle| > 0.15` (~8.6 deg) — i.e. it only fired once the
 * car was ALREADY sliding, and only in the drift state. Nothing at all was
 * driven by cornering LOAD, so a 30 km/h hairpin and a 200 km/h sweeper
 * produced identical silence right up to the moment of a slide.
 *
 * This produces a single 0..1+ scalar where 1.0 = at the limit:
 *
 *   - LATERAL LOAD: a_lat = v * yawRate, over the car's lateral grip ceiling.
 *     This is the honest "approaching the limit" signal and it separates a
 *     slow corner from a fast one for free — the same steering angle at twice
 *     the speed is four times the lateral acceleration.
 *   - SLIP: |slipAngle| over a reference angle. Takes over once the tyres
 *     actually break away, so the sound continues smoothly into a slide
 *     rather than restarting.
 *
 * The larger of the two wins, then it's EMA-smoothed — the raw signal is
 * jittery per-frame and un-smoothed audio gain chatters audibly.
 *
 * Deliberately NOT a physics change. This only READS state and emits a
 * number; the driving-feel rules forbid touching motion for feedback (no
 * camera or sprite cues, no v_lat softening), so the output drives sound and
 * controller rumble only.
 */
import { WPX_PER_M } from '@/config/world/tiles';

/**
 * Lateral acceleration at which THIS GAME's tyres are at the limit, m/s^2.
 * Scaled per car by the grip multiplier the caller passes (tyre upgrades /
 * faults / surface).
 *
 * MEASURED, not assumed. A real-world 0.92 g (9.0) was the first value and it
 * was badly wrong: tools/physlab/tirescrub.mjs shows this arcade physics pulls
 * up to 22.5 m/s^2 (2.3 g), so a 9.0 ceiling pinned the signal at its cap from
 * 45 mph upward — every corner above that read identical, which is the exact
 * complaint this is meant to fix, just moved up the speed range.
 *
 * 16.5 is where the RX-7 probe's slip angle crosses ~5.7 deg — the same point
 * the H1108 cornering scrub starts biting, i.e. where the car genuinely begins
 * to let go. So gripUse ~= 1.0 means "at the limit" in this game's terms.
 */
const LAT_LIMIT_MPS2 = 16.5;
/** Slip angle (rad) treated as fully saturated — ~8 deg, just past the point
 *  the H1108 cornering scrub starts biting at 5.7 deg. */
const SLIP_REF = 0.14;
/** Below this speed (wpx/s) tyres don't sing — parking manoeuvres and pit-lane
 *  crawling must stay silent no matter how hard the wheel is turned. */
const MIN_SPEED = 26;
/** EMA time constant (s). Fast enough to catch a flick, slow enough not to
 *  buzz. */
const SMOOTH_TAU = 0.09;

export interface TireLoadState {
  /** Previous heading, for the yaw-rate difference. NaN until first tick. */
  prevAngle: number;
  /** Smoothed utilisation, 0..~1.4. */
  value: number;
}

export function createTireLoadState(): TireLoadState {
  return { prevAngle: NaN, value: 0 };
}

/** Shortest signed angular difference a-b, wrapped to [-pi, pi]. */
function angDelta(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Advance one frame and return the smoothed grip utilisation (0 = straight
 * line, 1 = at the limit, >1 = past it and sliding).
 *
 * @param gripMult per-car / per-surface grip scalar (1 = nominal). Lower grip
 *                 means the same corner uses more of the available envelope,
 *                 which is exactly what should make worn tyres howl earlier.
 */
export function tickTireLoad(
  s: TireLoadState,
  pAngle: number,
  pSpeed: number,
  slipAngle: number,
  gripMult: number,
  dt: number,
): number {
  if (dt <= 0) return s.value;
  const prev = s.prevAngle;
  s.prevAngle = pAngle;
  const absSpd = Math.abs(pSpeed);
  if (Number.isNaN(prev) || absSpd < MIN_SPEED) {
    // Decay rather than snap to 0, so coming to a stop mid-slide fades out.
    s.value += (0 - s.value) * Math.min(1, dt / SMOOTH_TAU);
    return s.value;
  }
  const yawRate = angDelta(pAngle, prev) / dt;                 // rad/s
  const aLat = Math.abs((absSpd * yawRate) / WPX_PER_M);       // m/s^2
  const ceiling = Math.max(1, LAT_LIMIT_MPS2 * Math.max(0.2, gripMult));
  const latUse = aLat / ceiling;
  const slipUse = Math.abs(slipAngle) / SLIP_REF;
  // Cap well above 1 so a big slide still reads as "past the limit" without
  // the number running away and blowing out downstream gain curves.
  const raw = Math.min(1.6, Math.max(latUse, slipUse));
  s.value += (raw - s.value) * Math.min(1, dt / SMOOTH_TAU);
  return s.value;
}
