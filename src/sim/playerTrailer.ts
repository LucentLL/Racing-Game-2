/**
 * Per-frame update for the player's hitched trailer (TRUCK DRIVER job).
 * Runs the monolith's full updateTrailer sequence (L27795-L27944) on the
 * cab + trailer each frame:
 *
 *   1. Articulation ODE  — advance the trailer's world heading so it
 *      off-tracks behind the cab through turns ([[trailerKinematicTick]]).
 *   2. Jackknife zones    — warn at 60° / 75° and HARD-CLAMP at 90° so the
 *      trailer body physically can't fold through the cab (the user's
 *      "it jackknifes through the cab" report).
 *   3. Hard-brake swing   — locked drive wheels deep in articulation pivot
 *      the cab around the fifth wheel (jackknife precursor).
 *   4. Trailer drag       — load-weight-dependent rolling/aero penalty.
 *   5. Speed governor      — cap at the fleet ~70 mph governed top.
 *   6. Jackknife skids     — lay rubber from the dragged trailer tandem.
 *
 * The semi runs the LEGACY physics path whenever a trailer is hooked (the
 * Phase 0B integrator's eligibility check is `... && !LIFE.trailer`), so
 * the cab yaw rate the ODE needs is derived from the per-frame heading
 * delta (held in a module memo) rather than read off the integrator. This
 * function mutates player.pSpeed / player.pAngle (drag, governor, clamp,
 * swing) and life.trailer.angle / .jackknife; it runs late in the frame
 * (after position integration) so its speed/heading nudges land on the
 * NEXT frame, matching the monolith's call order.
 *
 * Vehicle-vs-trailer collision (race cars ducking under the deck, hitting
 * only the axles/kingpin) lives separately in
 * physics/trafficCollision.ts:tickPlayerTrailerTrafficCollision, since it
 * iterates the traffic pool. See physics/trailer.ts:trailerVsVehicle.
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import type { SkidMarkState } from '@/state/skidMarks';
import { addSkidMark } from '@/state/skidMarks';
import { SCALE_MS } from '@/physics/physicsUnits';
import {
  trailerKinematicTick,
  trailerArticulationAngle,
  trailerJackknifeZone,
  applyTrailerJackknifeClamp,
  applyTrailerHardBrakeSwing,
  applyTrailerDrag,
  applyTrailerSpeedGovernor,
  computeFifthWheelPivot,
  computeTrailerRearAxleWheels,
  TRAILER_WARNING_THRESHOLD,
} from '@/physics/trailer';

/** Previous-frame cab heading, used to derive the cab yaw rate. Null
 *  when no trailer is hooked (reset so the next hook re-seeds cleanly,
 *  yielding a 0 yaw rate on the first frame instead of a spike from a
 *  stale angle). */
let _prevCabAngle: number | null = null;

/** Speed (game units) above which the dragged-trailer tandem lays skid
 *  marks while jackknifed. Matches monolith `absSpd > 2*SCALE_MS` at
 *  L27928. */
const JACKKNIFE_SKID_MIN_SPEED = 2 * SCALE_MS;

/** Per-frame side inputs [[tickPlayerTrailer]] needs from the game loop. */
export interface PlayerTrailerDeps {
  /** True when brake OR e-brake is held this frame — gates the
   *  hard-brake cab swing. */
  braking: boolean;
  /** Shared skid-mark pool; the jackknifed tandem lays rubber here. */
  skids: SkidMarkState;
  /** Surface test at a world position (road → dark skid, else dust-ish).
   *  Used only to tint the trailer skid marks. */
  onRoadAt: (x: number, y: number) => boolean;
  /** Notification sink for the articulation warnings. */
  showNotif: (msg: string) => void;
  /** Wall-clock ms for the rate-limited caution notif (monolith uses
   *  Date.now() so signage keeps blinking even with the game clock
   *  paused). */
  nowMs: number;
}

/** Advance the hitched trailer one frame: articulation, jackknife clamp,
 *  hard-brake swing, drag, governor, and jackknife skids. No-op (and
 *  resets the yaw-rate memo) when no trailer is hooked. */
export function tickPlayerTrailer(
  life: LifeState,
  player: PlayerState,
  dt: number,
  deps: PlayerTrailerDeps,
): void {
  // H1128: failsafe — mid-haul (job picked up, shift not done) with no
  // trailer object, re-create one so a state hiccup can't strand the
  // run. 1:1 port of monolith updateTrailer L27804-27810 (both arms;
  // dims match the ARRIVAL_SPECS onPickup literals in jobArrival.ts).
  if (!life.trailer && life.job?.pickedUp && !life.jobDoneToday) {
    if (life.playerJob === 'TRUCK DRIVER') {
      life.trailer = {
        angle: player.pAngle, length: 73, width: 17, jackknife: 0,
        trailerType: 'box', loadWeight: 0.3 + Math.random() * 0.7,
      };
    } else if (life.playerJob === 'FUEL TANKER') {
      life.trailer = {
        angle: player.pAngle, length: 58, width: 16, jackknife: 0,
        trailerType: 'tanker', loadWeight: 0.7 + Math.random() * 0.3,
      };
    }
  }
  const tr = life.trailer;
  if (!tr) {
    _prevCabAngle = null;
    return;
  }

  // === 1. Cab yaw rate from the shortest-arc heading delta ===
  let pAngVel = 0;
  if (_prevCabAngle != null && dt > 0) {
    const d = Math.atan2(
      Math.sin(player.pAngle - _prevCabAngle),
      Math.cos(player.pAngle - _prevCabAngle),
    );
    pAngVel = d / dt;
  }

  // === 1b. Articulation ODE — trailer off-tracks behind the cab ===
  tr.angle = trailerKinematicTick({
    pAngle: player.pAngle,
    pAngVel,
    pSpeed: player.pSpeed,
    trailerAngle: tr.angle,
    trailerLength: tr.length,
    dt,
  });

  // === 2. Articulation angle + jackknife zones ===
  const art = trailerArticulationAngle(player.pAngle, tr.angle);
  const jackAngle = Math.abs(art);
  tr.jackknife = jackAngle;
  const zone = trailerJackknifeZone(art);
  if (zone === 'caution') {
    // Rate-limited blink (monolith L27888: every other 1.5s window).
    if (Math.floor(deps.nowMs / 1500) % 2 === 0) {
      deps.showNotif('⚠️ Tight articulation — watch your mirrors!');
    }
  } else if (zone === 'warning') {
    deps.showNotif('⚠️ JACKKNIFE WARNING! Pull forward!');
  } else if (zone === 'jackknife') {
    deps.showNotif('🛑 JACKKNIFE! Pull forward to recover!');
  }

  // === 3. 90°+ hard limit — clamp φ so the body can't fold through the
  //        cab, and bleed speed for the rubbing contact ===
  const clamp = applyTrailerJackknifeClamp(player.pAngle, tr.angle, player.pSpeed, art);
  tr.angle = clamp.trailerAngle;
  player.pSpeed = clamp.pSpeed;

  // === 4. Hard-brake cab swing (uses the pre-clamp articulation, as the
  //        monolith does) ===
  player.pAngle = applyTrailerHardBrakeSwing(
    player.pAngle, player.pSpeed, art, deps.braking, SCALE_MS, dt,
  );

  // === 5. Trailer drag (load-weight dependent) ===
  player.pSpeed = applyTrailerDrag(player.pSpeed, tr.loadWeight, dt);

  // === 6. Speed governor (~70 mph with a trailer regardless of cab top) ===
  player.pSpeed = applyTrailerSpeedGovernor(player.pSpeed, SCALE_MS);

  // === 7. Skid marks from the dragged/jackknifed tandem ===
  if (jackAngle > TRAILER_WARNING_THRESHOLD && Math.abs(player.pSpeed) > JACKKNIFE_SKID_MIN_SPEED) {
    const piv = computeFifthWheelPivot(player.px, player.py, player.pAngle);
    const w = computeTrailerRearAxleWheels(piv.fwX, piv.fwY, tr.angle, tr.length, tr.width);
    const onRoad = deps.onRoadAt(w.centerX, w.centerY);
    addSkidMark(deps.skids, w.leftX, w.leftY, 1.2, onRoad);
    addSkidMark(deps.skids, w.rightX, w.rightY, 1.2, onRoad);
  }

  // Memo the END-of-frame cab heading (after the swing) so next frame's
  // yaw rate measures only the physics-driven heading change.
  _prevCabAngle = player.pAngle;
}
