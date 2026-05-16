/**
 * Automatic-transmission gear pick + RPM target + smoothing integrator.
 * 1:1 port of the inline H83/H84/H85/H86 logic from gameLoop.ts, which
 * itself ports from monolith L26418-26473:
 *   - L26388-26391  gear bracket walk (`for g=1..gears: if aSpd<GS[g] break`)
 *   - L26418-26422  upshift detect → gearShiftTimer = 0.15, decrement dt
 *   - L26424-26462  gearFrac → targetRPM (3-way ternary: shifting/gas/coast)
 *   - L26473        pRPM exponential approach with shifting?12:5 rate
 *
 * Deferred (each needs state not yet ported, slots remain in monolith
 * for when the dependencies land):
 *   - fxFault.shiftMult — fault-system multiplier on the 150ms base.
 *   - Downshift cushion — monolith branch is explicitly upshift-only.
 *   - _slipRev (L26447-26462) — grass/dirt wheelspin RPM pump. Needs
 *     pDrifting + pDrift + onTile state.
 *   - Rev limiter bounce + tire slip ripple (L26485-26498) — needs
 *     pWheelspinRatio and performance.now() ripple modulation atop the
 *     integrator output.
 *   - Manual transmission state — manualGear/manualGearTimer (L26380-
 *     26417). Needs +/- shift input plumb + LIFE.isManual flag.
 *
 * Pure side-effect on PlayerState — mutates prevGear, gearShiftTimer,
 * pRpm. No return.
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
): void {
  // Bracket walk: pick the gear whose upper bound is the first to
  // exceed |pSpeed|. Top gear is the default fall-through.
  const GS = car.gearSpeeds;
  const aSpd = Math.abs(player.pSpeed);
  let pGear = car.gears;
  for (let i = 1; i < car.gears; i++) {
    if (aSpd < GS[i]) { pGear = i; break; }
  }

  // Upshift detect → start 150ms shift timer. Downshifts skip the dip.
  if (pGear !== player.prevGear && pGear > 0 && player.prevGear > 0 && pGear > player.prevGear) {
    player.gearShiftTimer = 0.15;
  }
  if (player.gearShiftTimer > 0) player.gearShiftTimer -= dt;
  player.prevGear = pGear;

  // Target RPM: three branches matching monolith L26461-26462.
  const shifting = player.gearShiftTimer > 0;
  const gearLow = GS[Math.max(0, pGear - 1)] ?? 0;
  const gearHigh = GS[pGear] ?? car.topSpeed;
  const gearFrac = pGear === 0 ? 0.3 : Math.min(1, (aSpd - gearLow) / (gearHigh - gearLow || 1));
  const rpmRange = car.redline - car.idleRPM;
  const target = shifting
    ? car.idleRPM + gearFrac * rpmRange * 0.3
    : (gasHeld
        ? car.idleRPM + Math.min(1, gearFrac) * rpmRange * 0.97
        : car.idleRPM + gearFrac * rpmRange * 0.5);

  // Exponential approach. k=12 during the shift window so the post-
  // upshift drop settles in ~85ms; k=5 otherwise (~200ms).
  const k = shifting ? 12 : 5;
  player.pRpm += (target - player.pRpm) * k * dt;
}
