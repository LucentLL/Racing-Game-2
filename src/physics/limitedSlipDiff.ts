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

/** Per-axle longitudinal force tuple — re-exported with the same
 *  shape as driveForce.ts's AxleLongitudinalForces. Kept as a
 *  local interface to avoid cross-module type imports for what
 *  is conceptually the same data. */
export interface AxleForces {
  F_long_F: number;
  F_long_R: number;
}

/** Apply the LSD effectiveness multiplier to the driven axle(s).
 *  Composes [[computeLsdEffectiveness]] with the drivetrain
 *  layout and the welded-mod override.
 *
 *  PIPELINE (1:1 with monolith):
 *    accelF = isWelded ? 1.0 : (gt4LsdAccelF / 100)
 *    accelR = isWelded ? 1.0 : (gt4LsdAccelR / 100)
 *    FF      :  F_long_F × effectiveness(accelF)
 *    RWD     :  F_long_R × effectiveness(accelR)
 *    4WD     :  F_long_F × effectiveness(accelF),
 *               F_long_R × effectiveness(accelR)
 *
 *  WHY ONLY DRIVEN AXLES: the LSD sits on the driven axle. The
 *  non-driven axle has no longitudinal drive force to multiply
 *  against — its F_long is zero from
 *  [[distributeDriveToAxles]] and the LSD multiplier is moot.
 *
 *  WHY THROTTLE-ONLY (caller's gate): brake force bypasses the
 *  diff because the calipers grip wheels directly. The decel
 *  values in cc.gt4.lsd (lsd[4], lsd[5]) are parsed but unused
 *  here — a follow-up could wire them to the engine-brake path
 *  if coast-feel differentiation is wanted.
 *
 *  WELDED-MOD OVERRIDE (v8.61): a welded-diff mod forces both
 *  axles to 100 % lock regardless of factory configuration.
 *  The cheap-trick drift mod — literally weld the spider gears
 *  (can be DIY'd or done at a mechanic). Overrides whatever
 *  the factory diff was.
 *
 *  INPUTS:
 *    forces           current {F_long_F, F_long_R} from
 *                     [[distributeDriveToAxles]] (driveForce.ts)
 *    drivetrain       chassis drivetrain enum
 *    gt4LsdAccelF     cc.gt4.lsd[2] — front accel lock %;
 *                     undefined OK
 *    gt4LsdAccelR     cc.gt4.lsd[3] — rear accel lock %;
 *                     undefined OK
 *    isWelded         LIFE.welded — welded-diff mod flag
 *
 *  Returns the per-axle forces with LSD applied. Non-driven
 *  axles flow through unchanged.
 *
 *  CALLER PRE-CONDITIONS (this function assumes; not checked):
 *  - isThrottle (caller has decided drive-power is being applied)
 *  - LIFE.gameplaySettings.lsd !== false
 *  - cc.gt4.lsd exists (caller passes accelF/accelR from it)
 *  When any of these fails, the caller should SKIP calling this
 *  function entirely — letting forces flow through unchanged.
 *
 *  Ported 1:1 from monolith L25680-L25689 (the per-drivetrain
 *  LSD multiplier block, plus the welded override at L25679). */
export function applyLsdToAxleForces(
  forces: AxleForces,
  drivetrain: Drivetrain,
  gt4LsdAccelF: number | undefined,
  gt4LsdAccelR: number | undefined,
  isWelded: boolean,
): AxleForces {
  const accelF = isWelded ? LSD_WELDED_LOCK : (gt4LsdAccelF || 0) / 100;
  const accelR = isWelded ? LSD_WELDED_LOCK : (gt4LsdAccelR || 0) / 100;
  switch (drivetrain) {
    case 'FF':
      return {
        F_long_F: forces.F_long_F * computeLsdEffectiveness(accelF),
        F_long_R: forces.F_long_R,
      };
    case 'FR':
    case 'MR':
    case 'RR':
      return {
        F_long_F: forces.F_long_F,
        F_long_R: forces.F_long_R * computeLsdEffectiveness(accelR),
      };
    case '4WD':
      return {
        F_long_F: forces.F_long_F * computeLsdEffectiveness(accelF),
        F_long_R: forces.F_long_R * computeLsdEffectiveness(accelR),
      };
    default:
      return forces;
  }
}
