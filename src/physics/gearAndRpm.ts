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
): void {
  // Bracket walk: pick the gear whose upper bound is the first to
  // exceed |pSpeed|. Top gear is the default fall-through.
  const GS = car.gearSpeeds;
  const aSpd = Math.abs(player.pSpeed);
  let pGear = car.gears;
  for (let i = 1; i < car.gears; i++) {
    if (aSpd < GS[i]) { pGear = i; break; }
  }

  // H99: manual override. 1:1 port of monolith L26393-26417 (the
  // non-isManual branch — when the driver presses a shift bump, hold
  // their gear for 4 seconds before reverting to bracket-walk
  // auto-pick). Safety bumps auto-upshift on 1.75× over-rev and
  // auto-downshift on 0.40× lug so an extreme manual choice doesn't
  // peg the limiter or stall. Only honors the override while pSpeed>0
  // and pGear>0 (forward gears only — reverse stays manual-immune).
  if (player.manualGearTimer > 0) {
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

  // Target RPM: three branches matching monolith L26461-26462.
  const shifting = player.gearShiftTimer > 0;
  const gearLow = GS[Math.max(0, pGear - 1)] ?? 0;
  const gearHigh = GS[pGear] ?? car.topSpeed;
  const gearFrac = pGear === 0 ? 0.3 : Math.min(1, (aSpd - gearLow) / (gearHigh - gearLow || 1));
  const rpmRange = car.redline - car.idleRPM;
  let target = shifting
    ? car.idleRPM + gearFrac * rpmRange * 0.3
    : (gasHeld
        ? car.idleRPM + Math.min(1, gearFrac) * rpmRange * 0.97
        : car.idleRPM + gearFrac * rpmRange * 0.5);

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

  // H101: rev-limiter bounce. 1:1 port of monolith L26485-26491 (the
  // _atLimit branch only — tire-slip ripple at L26491-26495 needs
  // pWheelspinRatio which hasn't ported). Real rev limiters cycle
  // fuel at ~8-15 Hz producing characteristic needle chatter when the
  // engine sits at redline under throttle. The rectified sine wave
  // (|sin(t*37.7)|) gives one-sided 12 Hz peaks that look right on the
  // tachometer and audibly buzz the engine sound (H87 reads pRpm into
  // the audio pitch).
  //
  //   _atLimit  = target >= redline*0.98 && gas
  //   _limBounce = |sin(t*37.7)|         // ~12 Hz rectified
  //   pRpm     -= _limBounce * redline * 0.04
  //
  // Skipped during shift window — the monolith gates this on !shifting
  // because the shift-target dip already moves the needle audibly.
  if (!shifting && gasHeld && target >= car.redline * 0.98) {
    const _t = performance.now() * 0.001;
    const _limBounce = Math.abs(Math.sin(_t * 37.7));
    player.pRpm -= _limBounce * car.redline * 0.04;
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
