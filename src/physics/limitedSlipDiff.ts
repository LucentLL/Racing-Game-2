/**
 * Phase 2 (v8.60) limited-slip differential effects.
 *
 * A differential's lock percentage controls how much drive torque
 * reaches the pavement when the two driven wheels don't spin at
 * identical rates (in a turn, or when one wheel is on grass).
 *
 *   Open diff (0 % lock):  sends equal torque to both wheels. If
 *                          one slips, the other gets the same
 *                          (limited) torque — peak drive output
 *                          drops.
 *   Locked diff (100 %):   rigid axle. Full torque retention but
 *                          bad steering feel.
 *
 * Implemented as a per-axle effectiveness multiplier on the
 * already-distributed F_long values (from
 * [[distributeDriveToAxles]] in driveForce.ts). Not applied to
 * brake force — friction brakes bypass the diff because the
 * calipers grip wheels directly.
 *
 * GT4 spec data: cc.gt4.lsd = [initF, initR, accelF, accelR,
 *                              decelF, decelR]
 *   FF:       uses accelF = lsd[2]
 *   FR/MR/RR: uses accelR = lsd[3]
 *   4WD:      uses both
 *
 * decelF/decelR (overrun/engine-brake) are parsed but unused
 * here; a follow-up could wire them to the engine-brake path
 * if coast-feel differentiation is wanted.
 *
 * v8.61 added the welded-diff mod (LIFE.welded): forces both
 * axles' accel locks to 100 % regardless of factory diff. The
 * cheap-trick drift mod — literally weld the spider gears, can
 * be DIY'd or done at a mechanic.
 *
 * Console-flippable via `LIFE.gameplaySettings.lsd = false`.
 *
 * Monolith source: inside update() at L25674-L25690.
 */

import type { Drivetrain } from './steering';

/** Open-diff effectiveness floor — the minimum drive-force
 *  delivery for a 0 %-lock (fully open) differential. 0.5 means
 *  an open diff delivers 50 % of the demanded F_long under power.
 *  This represents the inside-wheel-spinning loss that
 *  characterizes open diffs in turning maneuvers.
 *
 *  Matches monolith `_LSD_MIN = 0.5` at L25677. */
export const LSD_OPEN_FLOOR = 0.5;

/** Welded-diff lock fraction. When the welded-mod is active,
 *  both axles' accel locks are forced to 1.0 (100 % lock). The
 *  cheap-trick drift mod from v8.61 — both axles act as solid
 *  rigid shafts.
 *
 *  Matches monolith `_weld ? 1.0` at L25680. */
export const LSD_WELDED_LOCK = 1.0;

/** Compute the effective drive-delivery multiplier for a given
 *  differential lock fraction.
 *
 *  FORMULA (1:1 with monolith):
 *    eff = LSD_OPEN_FLOOR + (1 - LSD_OPEN_FLOOR) × lockFraction
 *        = 0.5 + 0.5 × lockFraction
 *
 *  TYPICAL EFFECTS AT FULL THROTTLE:
 *    0 % lock (open — 111/366 cars: 2CV, base Civics,
 *              stock pony cars):                       0.50×
 *    20 % lock (mild sporty — Abarth FF, tuner econ):  0.60×
 *    30 % lock (touring — AC Cobra, NSX-class):        0.65×
 *    40 % lock (GT race — CLK-GTR, Alfa 155 TI):       0.70×
 *    80 % lock (GT1 spec race cars):                   0.90×
 *    100 % lock (welded or full lock):                 1.00×
 *
 *  GAMEPLAY FEEL:
 *  - Open-diff cars: acceleration feels "gummy"; inside wheel
 *    wastes torque; power-on oversteer comes with less
 *    precision (because torque can't be reliably delivered to
 *    the loaded outside wheel).
 *  - Tight-diff cars: hooked up, predictable, full grip-circle
 *    usage; classic drifty-beast behavior under throttle (the
 *    rear axle stays committed to whatever the player
 *    demands).
 *
 *  INPUTS:
 *    lockFraction   diff lock as a [0, 1] fraction; the caller
 *                   converts from spec percentage via /100
 *
 *  Returns the effectiveness multiplier in [LSD_OPEN_FLOOR, 1.0].
 *
 *  Ported 1:1 from monolith L25677-L25678 and the per-axle
 *  multiplier pattern at L25683/L25685/L25687-L25688 (the
 *  `_LSD_MIN + _LSD_RANGE × _accelX` formula). */
export function computeLsdEffectiveness(lockFraction: number): number {
  return LSD_OPEN_FLOOR + (1 - LSD_OPEN_FLOOR) * lockFraction;
}
