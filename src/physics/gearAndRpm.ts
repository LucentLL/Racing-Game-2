/**
 * Automatic-transmission gear pick + RPM target + smoothing integrator.
 * Ports the H83/H84/H85/H86/H99 logic from gameLoop.ts, which itself
 * ports from monolith L26388-26473:
 *   - L26388-26391  gear bracket walk (`for g=1..gears: if aSpd<GS[g] break`)
 *   - L26393-26417  manual-shift override + safety bumps (H99)
 *   - L26418-26422  upshift detect → gearShiftTimer = 0.15, decrement dt
 *   - L26424-26462  gearFrac → targetRPM (3-way ternary: shifting/gas/coast)
 *   - L26473        pRPM exponential approach with shifting?12:5 rate
 *
 * Deferred (each needs state not yet ported, slots remain in monolith
 * for when the dependencies land):
 *   - Downshift cushion — monolith branch is explicitly upshift-only.
 *   - _slipRev (L26447-26462) — grass/dirt wheelspin RPM pump. Needs
 *     pDrifting + pDrift + onTile state.
 *   - Rev limiter bounce + tire slip ripple (L26485-26498) — needs
 *     pWheelspinRatio and performance.now() ripple modulation atop the
 *     integrator output.
 *   - LIFE.isManual flag — when true, the monolith L26381-26386 branch
 *     holds the driver's gear PERMANENTLY (no 4-second revert). Needs
 *     the garage-shop transmission-swap UI to port first.
 *
 * Pure side-effect on PlayerState — mutates prevGear, gearShiftTimer,
 * pRpm, manualGear, manualGearTimer. No return.
 */

import type { PlayerState } from '@/state/player';
import type { CatalogCar } from '@/config/cars/catalog';

/** Per-frame automatic gear + RPM tick. Mutates player.prevGear,
 *  player.gearShiftTimer, player.pRpm. Read the final gear via
 *  player.prevGear after the call.
 *
 *  @param player    Mutated in place — prevGear, gearShiftTimer, pRpm.
 *  @param car       Active catalog car (gearSpeeds / gears / redline /
 *                   idleRPM / topSpeed). Caller resolves activeCar
 *                   from LIFE.ownedCars[0] + CAR_CATALOG.
 *  @param gasHeld   ctx.input.gas — controls the no-shift target's
 *                   gas-down (0.97 redline) vs coast (0.5 redline)
 *                   branch.
 *  @param dt        Frame dt seconds. Same value used everywhere else
 *                   in arcadeUpdate / clock / wear ticks.
 */
export function tickGearAndRpm(
  player: PlayerState,
  car: CatalogCar,
  gasHeld: boolean,
  dt: number,
  rpmFlutter: boolean = false,
  shiftMult: number = 1,
  manualMode: boolean = false,
): void {
  // Bracket walk: pick the gear whose upper bound is the first to
  // exceed |pSpeed|. Top gear is the default fall-through.
  const GS = car.gearSpeeds;
  const aSpd = Math.abs(player.pSpeed);
  let pGear = car.gears;
  for (let i = 1; i < car.gears; i++) {
    if (aSpd < GS[i]) { pGear = i; break; }
  }

  // H1021: PERSISTENT manual transmission (the deferred isManual branch, see
  // the file header). Holds the driver's chosen gear indefinitely — no auto
  // bracket-walk pick, no 4-second revert, no safety auto-shift. The rev
  // limiter (RPM clamp below) is the only guard; lug it or bounce the limiter
  // if you pick the wrong gear. manualGear seeds from the auto pick the first
  // frame so it starts sensible; the e/q keys, mobile knob, and gamepad flick
  // all just step manualGear.
  if (manualMode) {
    if (player.manualGear === null) player.manualGear = Math.max(1, pGear);
    pGear = Math.max(1, Math.min(car.gears, player.manualGear));
    player.manualGearTimer = 0;
  } else if (player.manualGearTimer > 0) {
    // H99: temporary manual override (auto transmission). 1:1 port of the
    // non-isManual branch — when the driver presses a shift bump, hold their
    // gear for 4 seconds before reverting to bracket-walk auto-pick. Safety
    // bumps auto-upshift on 1.75× over-rev and auto-downshift on 0.40× lug so
    // an extreme manual choice doesn't peg the limiter or stall. Only honors
    // the override while pSpeed>0 and pGear>0 (forward gears only).
    player.manualGearTimer -= dt;
    if (player.manualGearTimer <= 0) {
      player.manualGear = null;
    } else if (player.manualGear !== null && player.pSpeed > 0 && pGear > 0) {
      let target = Math.max(1, Math.min(car.gears, player.manualGear));
      const gsLow = GS[Math.max(0, target - 1)] ?? 0;
      const gsHigh = GS[target] ?? car.topSpeed;
      if (aSpd > gsHigh * 1.75 && target < car.gears) {
        target++;
        player.manualGear = target;
      } else if (aSpd < gsLow * 0.40 && target > 1) {
        target--;
        player.manualGear = target;
      }
      pGear = target;
    }
  }

  // Upshift detect → start 150ms shift timer. Downshifts skip the dip.
  // H256: shiftMult fault — trans_slip (3.0) stretches the dip to
  // 450ms; trans_hesitation (2.5) to 375ms. 1:1 with monolith L26420
  // `gearShiftTimer = 0.15 * fxFault.shiftMult`. Aggregator takes
  // the MAX of all contributing faults (a single trans fault wins)
  // so this scalar is the worst-case dip duration. Player feels it
  // as visibly slower upshifts — engine bog through the 0.3× rpm
  // multiplier the shift window already applies.
  if (pGear !== player.prevGear && pGear > 0 && player.prevGear > 0 && pGear > player.prevGear) {
    player.gearShiftTimer = 0.15 * shiftMult;
  }
  if (player.gearShiftTimer > 0) player.gearShiftTimer -= dt;
  player.prevGear = pGear;

  // H714: gear-ratio-aware RPM target. The monolith formula
  // (idleRPM + gearFrac × range × *) assumed every gear's RPM
  // range spanned idle→redline, which made RPM dive from redline
  // to idle on each upshift — `aSpd` at the upshift instant is
  // the new gear's `gearLow`, so gearFrac=0 → target=idleRPM.
  // User reported: "shifting up gears, the RPMS drop to 0,
  // which makes no sense."
  //
  // Replaced with the physical relationship: engine RPM is locked
  // to the wheels through the gearbox, so at speed aSpd in gear N
  //   rpm = redline × aSpd / GS[N]
  // bounded below by idleRPM (the engine never stops). After an
  // upshift from gear N-1 to N at the upshift point, the new RPM
  // is `redline × GS[N-1] / GS[N]` — for a 5-speed pattern
  // [.20, .35, .53, .76, 1.0] that's 57% / 66% / 70% / 76% of
  // redline across the upshifts. NO MORE DIVE TO IDLE.
  //
  // The 150 ms shift-window dip (matching the monolith's "audible
  // RPM dip on upshift" feel) is preserved as a 15% reduction
  // multiplier on the steady-state value, so the needle still
  // visibly drops during a shift before stabilizing in the new
  // gear's higher rpm band.
  //
  // Coast (no gas) and gas-held both target the same steady
  // value — the engine RPM is geared to wheels regardless of
  // throttle. The rev-limiter bounce + wheelspin-ripple
  // modulations below still fire on top via the same
  // `target >= redline × 0.98` gates as before.
  const shifting = player.gearShiftTimer > 0;
  const gearLow = GS[Math.max(0, pGear - 1)] ?? 0;
  const gearHigh = GS[pGear] ?? car.topSpeed;
  // Gear-ratio RPM floor — the rpm the gearbox locks the engine
  // to when aSpd sits at this gear's bottom edge. For reverse
  // (pGear=0) or a missing gearHigh, fall back to idleRPM.
  const rpmFloor = (pGear > 0 && gearHigh > 0)
    ? Math.max(car.idleRPM, car.redline * gearLow / gearHigh)
    : car.idleRPM;
  // Position within this gear's speed range, clamped [0, 1].
  const gearFrac = pGear === 0
    ? 0.3
    : Math.min(1, Math.max(0, (aSpd - gearLow) / Math.max(1, gearHigh - gearLow)));
  // Steady-state RPM = lerp(rpmFloor, redline, gearFrac). At
  // gearFrac=0 (just upshifted, or coasting at lugging speed)
  // we're at the floor; at gearFrac=1 (about to upshift) we're
  // at redline.
  const steady = rpmFloor + (car.redline - rpmFloor) * gearFrac;
  // H715: deepen the shift-window dip so the gauge shows a real
  // "shift bump" rather than a polite 15% nudge. During the 150 ms
  // shift window the target collapses to 45% of the steady value
  // (e.g. NSX 5→6 dips from ~78% redline down to ~35% then springs
  // back to ~78% — visible needle drop instead of a tiny waver).
  // Gas-held caps the post-window target a hair below redline so
  // the rev-limiter bounce's `target >= redline × 0.98` gate has
  // headroom.
  let target = shifting
    ? steady * 0.45
    : (gasHeld
        ? Math.min(steady, car.redline * 0.97)
        : steady);

  // H254: rpmFlutter fault — spark_plugs, intake_manifold, cam_sensor,
  // electrical_sensor, electrical_gremlin all add tach noise. 1:1
  // port of monolith L26465-26468: two superimposed sin waves at
  // different frequencies produce uneven flutter that looks like
  // real ignition misfire. Strong at idle / crawl (full amplitude),
  // damped to 30% while driving — players notice flutter most when
  // the engine is loaded against a stop, not while cruising.
  // Skipped during the shift window because the shift dip already
  // moves the needle audibly; doubling up would just read as noise.
  if (rpmFlutter && !shifting) {
    const t = performance.now();
    const flutter = Math.sin(t * 0.007) * 200 + Math.sin(t * 0.019) * 150;
    target += flutter * (aSpd < 3 ? 1.0 : 0.3);
  }

  // Exponential approach. k=12 during the shift window so the post-
  // upshift drop settles in ~85ms; k=5 otherwise (~200ms).
  const k = shifting ? 12 : 5;
  player.pRpm += (target - player.pRpm) * k * dt;

  // H101: rev-limiter bounce. 1:1 port of monolith L26485-26491
  // (the _atLimit branch). Real rev limiters cycle fuel at ~8-15 Hz
  // producing characteristic needle chatter when the engine sits at
  // redline under throttle. The rectified sine wave (|sin(t*37.7)|)
  // gives one-sided 12 Hz peaks that look right on the tachometer
  // and audibly buzz the engine sound (H87 reads pRpm into the
  // audio pitch).
  //
  //   _atLimit  = target >= redline*0.98 && gas
  //   _limBounce = |sin(t*37.7)|         // ~12 Hz rectified
  //   pRpm     -= _limBounce * redline * 0.04
  //
  // H516: tire-slip ripple is the else-branch counterpart — fires
  // when wheelspin > 0.15 + gas held, adding 3-harmonic positive
  // jitter so the needle floats while the wheels lose grip. The two
  // are mutually exclusive in the monolith (else-if at L26491);
  // matches that pattern here. Reads player.wheelspinRatio, which
  // the Phase 0B integrator (H501) syncs from
  // state.pWheelspinRatio + the H156 arcade-tier proxy syncs from
  // launch heuristics — either path populates the field so the
  // ripple gates correctly on whichever physics tier owns this
  // frame.
  //
  // Both branches skipped during the shift window — the monolith
  // gates on !shifting because the shift-target dip already moves
  // the needle audibly; doubling up would read as noise.
  if (!shifting && gasHeld && target >= car.redline * 0.98) {
    const _t = performance.now() * 0.001;
    const _limBounce = Math.abs(Math.sin(_t * 37.7));
    player.pRpm -= _limBounce * car.redline * 0.04;
  } else if (!shifting && gasHeld && player.wheelspinRatio > 0.15) {
    // 3-harmonic sine produces "loose" jitter — not a clean
    // sinusoid, reads like the engine surging through bursts of
    // grip loss. Frequencies 31 / 53 / 89 are coprime so the
    // composite never repeats at any short period; coefficients
    // 0.5 / 0.3 / 0.2 sum to 1.0 so peak amplitude × redline ×
    // 0.02 caps the jitter at ~2% of redline (~140 RPM on a
    // 7000-redline car). Matches monolith L26491-L26495.
    const _t = performance.now() * 0.001;
    const _slip = Math.sin(_t * 31) * 0.5 + Math.sin(_t * 53) * 0.3 + Math.sin(_t * 89) * 0.2;
    player.pRpm += _slip * car.redline * 0.02;
  }
  // Safety clamp matching monolith L26497-26498 — keeps pRpm sane
  // after any modulation. Without the limiter modulation, the
  // integrator alone won't exceed redline; the clamp is defensive
  // and protects future slip-ripple / fault-flutter ports from
  // producing out-of-range pRpm.
  if (player.pRpm > car.redline) player.pRpm = car.redline;
  if (player.pRpm < car.idleRPM * 0.7) player.pRpm = car.idleRPM * 0.7;
}

/** Off-road slip-rev coefficient (grass / dirt / canyon). When
 *  the driver floors it on a low-grip surface, real cars rev high
 *  while tires slip and ground speed crawls. Tuned to 0.9 — keeps
 *  the limiter from pinning immediately so throttle modulation
 *  still matters, while still producing the high-RPM-low-speed
 *  feel that drivers expect on loose surfaces.
 *
 *  Matches monolith `_slipRev = _gap * 0.9` at L25453. */
export const SLIP_REV_OFFROAD_COEFF = 0.9;

/** Drift-state slip-rev coefficient. e-brake-turn-floor-it
 *  should rev high because rear tires have already broken
 *  loose on pavement. Same gap-based model as offroad but
 *  scaled by `pDrift` (the 0..1 drift intensity) so light
 *  drifts give mild rev and fully committed drifts rev near
 *  redline. v8.98.33 added this — slightly lower coefficient
 *  (0.8 vs 0.9) because drifts are intentional driver actions
 *  while offroad slip is often unintentional and the extra rev
 *  on offroad makes the limit more obvious.
 *
 *  Matches monolith `_driftRev = _gap * 0.8 * pDrift` at L25457. */
export const SLIP_REV_DRIFT_COEFF = 0.8;

/** Compute the per-frame slip-rev RPM-pump bonus to apply on
 *  top of gearFrac before converting to target RPM. v8.98.32 +
 *  v8.98.33 — captures grass / dirt / canyon wheelspin AND
 *  drift-state wheelspin (e-brake + turn + throttle on
 *  pavement).
 *
 *  FORMULA (1:1 with monolith):
 *    if NOT gas OR shifting:      return 0
 *    speedFrac = min(1, aSpd / max(1, topSpeed))
 *    gap       = max(0, gasAmount - speedFrac)
 *    slipRev = 0
 *    if onGrass OR onDirt:        slipRev = gap × 0.9
 *    if pDrifting:                slipRev = max(slipRev,
 *                                              gap × 0.8 × pDrift)
 *    return slipRev
 *
 *  WHY GAP-BASED (gasAmount - speedFrac): the magnitude of
 *  expected wheelspin is the GAP between what the driver is
 *  asking for (gas input) and what the car is delivering
 *  (speed fraction of top). On pavement at steady throttle
 *  the gap is small. On grass with floored throttle the gap
 *  approaches 1.0 (full throttle, near-zero forward motion).
 *
 *  WHY max(slipRev, ...) FOR DRIFT (not addition): a drift
 *  ON grass shouldn't double-stack into a 1.7× rev pump. Using
 *  max keeps the two sources bounded — whichever is bigger
 *  wins, but they don't compound.
 *
 *  WHY SHIFT-GATED: during the 150 ms shift dip, the engine is
 *  in transition between gears and the RPM is following its own
 *  shift target (down then up). Adding slip-rev on top would
 *  fight that target and produce confusing tach behavior.
 *
 *  USAGE (caller-side composition):
 *  The slipRev value is meant to be added to gearFrac before
 *  the targetRPM formula:
 *    target = idleRPM + min(1, gearFrac + slipRev) × rpmRange × 0.97
 *  This composes naturally with [[tickGearAndRpm]] — a future
 *  hop will wire slipRev into the targetRPM formula there.
 *
 *  INPUTS:
 *    gasAmount    raw gas input [0, 1]
 *    aSpd         |pSpeed| (gu/s)
 *    topSpeed     car's top speed (gu/s)
 *    onGrass      surface is grass
 *    onDirt       surface is dirt / canyon (tiles 12/14/16)
 *    pDrifting    drift state flag
 *    pDrift       drift intensity [0, 1]
 *    shifting     gearShiftTimer > 0
 *    gasHeld      gas held this frame (false → return 0)
 *
 *  Returns slipRev in [0, ~1] (typically 0-0.95).
 *
 *  Ported 1:1 from monolith L25447-L25459 (the _slipRev block
 *  before the targetRPM ternary). */
export function computeSlipRev(
  gasAmount: number,
  aSpd: number,
  topSpeed: number,
  onGrass: boolean,
  onDirt: boolean,
  pDrifting: boolean,
  pDrift: number,
  shifting: boolean,
  gasHeld: boolean,
): number {
  if (!gasHeld || shifting) return 0;
  const speedFrac = Math.min(1, aSpd / Math.max(1, topSpeed));
  const gap = Math.max(0, gasAmount - speedFrac);
  let slipRev = 0;
  if (onGrass || onDirt) slipRev = gap * SLIP_REV_OFFROAD_COEFF;
  if (pDrifting) {
    const driftRev = gap * SLIP_REV_DRIFT_COEFF * pDrift;
    if (driftRev > slipRev) slipRev = driftRev;
  }
  return slipRev;
}

/** Effective rev-range ratio for the wheel-speed formula. 0.97
 *  ≈ the "useful" portion of the redline minus idle range (the
 *  top ~3 % at redline corresponds to over-rev / limiter
 *  cycling that doesn't represent additional wheel speed). Used
 *  to normalize the RPM fraction into [0, 1] for interpolating
 *  between gearSpeeds[pGear-1] and gearSpeeds[pGear].
 *
 *  Matches monolith `*0.97` at L26510. */
export const WHEEL_SPEED_REV_RANGE_FRAC = 0.97;

/** Per-frame wheel-speed result from [[computeWheelSpeed]]. */
export interface WheelSpeedResult {
  /** Analog wheel-speed in game units / sec, derived from the
   *  settled pRpm. Used by the HUD speedometer needle, the
   *  skidmark emitter, and tire SFX as the canonical
   *  "what speed are the wheels turning at" reading
   *  (distinct from pSpeed which is the GROUND speed). */
  pWheelSpeedGU: number;
  /** Difference between wheel-speed and ground-speed. Positive
   *  during wheelspin (wheels turning faster than the car is
   *  moving — burnouts, grass-throttle, drifts). Zero at
   *  steady grip-state cruise. */
  pWheelGap: number;
}

/** Compute the analog wheel-speed from settled pRPM and the gap
 *  vs. ground speed (pSpeed). v8.98.42 introduced this — mirrors
 *  the HUD speedometer formula and is also used by the skidmark
 *  emitter and tire SFX. Captures wheelspin from any source:
 *  0B friction-circle exceed, slipRev pumping on grass/drift,
 *  near-stationary burnouts — as long as the RPM implies the
 *  wheels are spinning faster than the car is moving.
 *
 *  FORMULA (1:1 with monolith):
 *    if pGear >= 1 AND gearSpeeds[pGear] is defined
 *       AND gearShiftTimer <= 0:
 *      gsLow   = gearSpeeds[pGear - 1] || 0
 *      gsHigh  = gearSpeeds[pGear]
 *      rpmFrac = clamp((pRPM - idleRPM)
 *                       / ((redline - idleRPM) × 0.97), 0, 1)
 *      pWheelSpeedGU = gsLow + rpmFrac × (gsHigh - gsLow)
 *      if pWheelSpeedGU < |pSpeed|: pWheelSpeedGU = |pSpeed|
 *    else:
 *      pWheelSpeedGU = |pSpeed|
 *    pWheelGap = pWheelSpeedGU - |pSpeed|
 *
 *  WHY SHIFT WINDOW FALLS BACK TO pSpeed: during the 150 ms
 *  shift dip, RPM transients (the dip-then-climb) don't
 *  correspond to wheel motion — the shift bog is engine-side,
 *  not wheel-side. Using pSpeed during shift preserves the HUD
 *  needle smoothness and prevents false-positive wheelspin
 *  detection.
 *
 *  WHY THE MINIMUM CLAMP AT |pSpeed|: the formula can produce
 *  values below ground speed when the RPM is unusually low for
 *  the current gear (e.g. mid-gear coasting). The clamp
 *  ensures wheelspeed never reads BELOW ground speed —
 *  physically impossible for a non-locked-wheel car, and would
 *  produce a confusing "negative wheelgap" reading.
 *
 *  WHY 0.97 (NOT 1.0) IN THE RPM RANGE: see
 *  [[WHEEL_SPEED_REV_RANGE_FRAC]] docstring — the top ~3 % of
 *  redline range is over-rev / limiter cycling that doesn't
 *  represent additional wheel speed.
 *
 *  INPUTS:
 *    pRPM             current engine RPM
 *    pSpeed           ground speed (signed)
 *    pGear            current gear
 *    gearSpeeds       cc.gearSpeeds
 *    idleRPM, redline car's RPM range
 *    gearShiftTimer   shift-dip countdown
 *
 *  Returns {pWheelSpeedGU, pWheelGap}. Caller assigns each.
 *
 *  Ported 1:1 from monolith L26507-L26516 (the analog wheel-
 *  speed block at the tail of the gear/RPM block). */
export function computeWheelSpeed(
  pRPM: number,
  pSpeed: number,
  pGear: number,
  gearSpeeds: readonly number[] | undefined,
  idleRPM: number,
  redline: number,
  gearShiftTimer: number,
): WheelSpeedResult {
  const absSpd = Math.abs(pSpeed);
  let pWheelSpeedGU = absSpd;
  if (
    pGear >= 1
    && gearSpeeds
    && gearSpeeds[pGear] !== undefined
    && gearShiftTimer <= 0
  ) {
    const gsLow = gearSpeeds[pGear - 1] || 0;
    const gsHigh = gearSpeeds[pGear];
    const rpmFrac = Math.max(
      0,
      Math.min(1, (pRPM - idleRPM) / ((redline - idleRPM) * WHEEL_SPEED_REV_RANGE_FRAC)),
    );
    pWheelSpeedGU = gsLow + rpmFrac * (gsHigh - gsLow);
    if (pWheelSpeedGU < absSpd) pWheelSpeedGU = absSpd;
  }
  return {
    pWheelSpeedGU,
    pWheelGap: pWheelSpeedGU - absSpd,
  };
}
