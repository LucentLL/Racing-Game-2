/**
 * Incoming-tow truck tick.
 *
 * After the player taps GARAGE / MECHANIC on the tow menu modal,
 * src/ui/modals/towMenu.ts seeds life.incomingTow with the spawn /
 * park geometry. Without this tick the truck just sits in state
 * forever — phase stays 'arriving', the player stays stranded.
 *
 * H598 ports monolith updateIncomingTow (L8728-L8792) +
 * finishIncomingTow (L8794-L8819):
 *
 *   - 'arriving'  truck drives toward parkX/parkY at ~40 mph; on
 *                 arrival flips to 'reversing'.
 *   - 'reversing' truck pivots in place over 1.2s (ease-in-out)
 *                 from arriveAngle → parkAngle; flips to 'loading'.
 *   - 'loading'   3s loading animation; player locked at original
 *                 car position. Flips to 'departing'.
 *   - 'departing' truck drives off at 1.2× speed with the player
 *                 hidden inside. After 8s or 50-tile distance, fires
 *                 finishIncomingTow which warps the player home +
 *                 clears the broken state.
 *
 * H1130 (sanctioned deviation from the monolith, user ask
 * 2026-07-11): the truck FOLLOWS ROADS instead of beelining through
 *  grass. 'arriving' A*-routes spawn → park (sim/roadPath.ts) and
 * walks the waypoints, straight-lining only the short off-road final
 * approach to the stranded car; 'departing' walks the same route
 * back out. When no route exists (road islands, no tileMap passed)
 * every phase degrades to the original straight-line behavior — a
 * null path can never strand the recovery. H1129 wired the real
 * truck render (render/tow.ts via gameLoop's DrawTopCarFn adapter).
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import { SCALE_MS } from '@/physics/physicsUnits';
import { TILE } from '@/config/world/tiles';
import { showNotif as setNotifState } from '@/ui/notif';
import { findRoadPath } from '@/sim/roadPath';
import type { TargetTileMap } from '@/sim/jobTargets';

/** Tow-truck approach speed in game units per second. 18 wpx/s ×
 *  SCALE_MS ≈ 87 m/s ≈ 40 mph approach speed. Matches monolith
 *  L8731 `towSpd = 18 * SCALE_MS`. */
const TOW_APPROACH_SPEED = 18 * SCALE_MS;

/** Loading animation duration (seconds). Matches monolith L8772
 *  `t.loadProg = Math.min(1, t.timer/3)`. */
const TOW_LOAD_SECS = 3;

/** Reverse-pivot duration (seconds). Matches monolith L8753
 *  `const rotDur = 1.2`. */
const TOW_REVERSE_SECS = 1.2;

/** Departing-phase distance cap (TILE-units squared). Matches
 *  monolith L8787 `odx*odx + ody*ody > TILE*TILE*50*50`. */
const TOW_DEPART_DIST_SQ = TILE * TILE * 50 * 50;

/** Departing-phase timeout (seconds). Matches monolith L8787
 *  `t.timer > 8`. Backstop in case the depart geometry can't make
 *  the distance threshold (e.g. world wrap). */
const TOW_DEPART_TIMEOUT_SECS = 8;

interface IncomingTowState {
  phase: 'arriving' | 'reversing' | 'loading' | 'departing';
  x: number;
  y: number;
  angle: number;
  timer: number;
  choice: number;
  loadProg: number;
  parkX: number;
  parkY: number;
  arriveAngle: number;
  parkAngle: number;
  departDir: number;
  playerCarX: number;
  playerCarY: number;
  playerCarA: number;
  /** H1130: road route spawn→park (world-px waypoints). Built once
   *  on the first 'arriving' tick; null = A* failed → straight-line
   *  fallback. Plain data so a mid-tow save round-trips. */
  _route?: Array<{ x: number; y: number }> | null;
  /** H1130: current waypoint index into _route ('arriving' walks it
   *  forward; 'departing' walks it backward from the end). */
  _ri?: number;
  /** H1130: true once the route build was attempted (so a failed
   *  build doesn't re-run A* every frame). */
  _routeTried?: boolean;
  /** H1130: 'departing' cursor — counts DOWN through _route. */
  _di?: number;
}

/** Waypoint-arrival radius (world px) — half a tile keeps corner
 *  turns tight without orbiting a waypoint at speed. */
const WAYPOINT_R = TILE * 0.5;

/** Advance (x,y) toward (tx2,ty2) at spd, returning the heading.
 *  Snaps onto the target when within one step. */
function stepToward(
  t: { x: number; y: number; angle: number },
  tx2: number,
  ty2: number,
  spd: number,
  dt: number,
): number {
  const dx = tx2 - t.x;
  const dy = ty2 - t.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const ang = Math.atan2(dy, dx);
  if (dist > spd * dt) {
    t.x += Math.cos(ang) * spd * dt;
    t.y += Math.sin(ang) * spd * dt;
  } else {
    t.x = tx2;
    t.y = ty2;
  }
  t.angle = ang;
  return dist;
}

/** Advance the incoming-tow state one frame. No-op when
 *  life.incomingTow is unset. Caller runs this every tick — cheap
 *  when idle (single null check). */
export function tickIncomingTow(
  life: LifeState,
  player: PlayerState,
  dt: number,
  /** H1130: road-tile probe for the A* route. Optional — omitted
   *  (older call sites / tests) keeps the straight-line behavior. */
  tileMap?: TargetTileMap,
): void {
  const t = life.incomingTow as IncomingTowState | undefined | null;
  if (!t) return;

  if (t.phase === 'arriving') {
    // H1130: build the road route once. Null result (or no tileMap)
    // → the pre-H1130 straight line.
    if (!t._routeTried) {
      t._routeTried = true;
      t._route = tileMap
        ? findRoadPath(tileMap, t.x, t.y, t.parkX, t.parkY)
        : null;
      t._ri = 0;
    }
    const route = t._route;
    if (route && t._ri !== undefined && t._ri < route.length) {
      // Follow the road waypoints.
      const wp = route[t._ri];
      const dist = stepToward(t, wp.x, wp.y, TOW_APPROACH_SPEED, dt);
      if (dist <= Math.max(WAYPOINT_R, TOW_APPROACH_SPEED * dt)) t._ri++;
      return;
    }
    // Final (possibly off-road) approach to the stranded car — also
    // the whole leg when no route exists.
    const dx = t.parkX - t.x;
    const dy = t.parkY - t.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > TOW_APPROACH_SPEED * dt) {
      const ang = route ? Math.atan2(dy, dx) : t.arriveAngle;
      t.angle = ang;
      t.x += Math.cos(ang) * TOW_APPROACH_SPEED * dt;
      t.y += Math.sin(ang) * TOW_APPROACH_SPEED * dt;
    } else {
      t.x = t.parkX;
      t.y = t.parkY;
      // Ease the reverse-pivot from the heading the truck ACTUALLY
      // arrived on (a routed truck rarely arrives on arriveAngle).
      t.arriveAngle = t.angle;
      t.phase = 'reversing';
      t.timer = 0;
      setNotifState(life, '⏳ Positioning tow truck...', 150);
    }
    return;
  }

  if (t.phase === 'reversing') {
    t.timer += dt;
    const k = Math.min(1, t.timer / TOW_REVERSE_SECS);
    const ease = k < 0.5 ? (2 * k * k) : (1 - Math.pow(-2 * k + 2, 2) / 2);
    let da = t.parkAngle - t.arriveAngle;
    while (da >  Math.PI) da -= 2 * Math.PI;
    while (da < -Math.PI) da += 2 * Math.PI;
    t.angle = t.arriveAngle + da * ease;
    t.x = t.parkX;
    t.y = t.parkY;
    if (k >= 1) {
      t.angle = t.parkAngle;
      t.phase = 'loading';
      t.timer = 0;
      setNotifState(life, '⏳ Loading your car...', 180);
    }
    return;
  }

  if (t.phase === 'loading') {
    // Lock player to original car pose so they can't drift while
    // the winch animation runs.
    player.px = t.playerCarX;
    player.py = t.playerCarY;
    player.pSpeed = 0;
    if (typeof t.playerCarA === 'number') player.pAngle = t.playerCarA;
    t.timer += dt;
    t.loadProg = Math.min(1, t.timer / TOW_LOAD_SECS);
    if (t.loadProg >= 1) {
      t.phase = 'departing';
      t.timer = 0;
    }
    return;
  }

  if (t.phase === 'departing') {
    const departSpd = TOW_APPROACH_SPEED * 1.2;
    // H1130: leave the way it came — walk the arrival route backward,
    // then continue straight past its start. No route → the original
    // straight departDir line.
    if (t._di === undefined) {
      t._di = t._route && t._route.length > 0 ? t._route.length - 1 : -1;
    }
    const route = t._route;
    if (route && t._di >= 0) {
      const wp = route[t._di];
      const dist = stepToward(t, wp.x, wp.y, departSpd, dt);
      if (dist <= Math.max(WAYPOINT_R, departSpd * dt)) t._di--;
    } else {
      const ang = route ? t.angle : t.departDir;
      t.x += Math.cos(ang) * departSpd * dt;
      t.y += Math.sin(ang) * departSpd * dt;
      t.angle = ang;
    }
    // Player rides inside the truck.
    player.px = t.x;
    player.py = t.y;
    player.pSpeed = 0;
    t.timer += dt;
    const odx = t.x - t.playerCarX;
    const ody = t.y - t.playerCarY;
    if (odx * odx + ody * ody > TOW_DEPART_DIST_SQ || t.timer > TOW_DEPART_TIMEOUT_SECS) {
      finishIncomingTow(life, player, t.choice);
    }
  }
}

/** Send the player home and apply the tow choice's repair effect.
 *  Mirrors monolith finishIncomingTow at L8794-L8819. Cleared
 *  fields: life.broken, life.breakdownType, life.incomingTow.
 *  Choice 0 = garage tow (just sent home, no repair); choice 1 =
 *  mechanic tow (minimum drivable stats restored so the player
 *  isn't immediately broken again). The full pendingParts
 *  scheduling from the monolith doesn't port yet — the modular's
 *  parts pipeline doesn't carry pendingParts arrival hours either,
 *  so a bare minimum-drivable restoration is what the player
 *  observes today. */
function finishIncomingTow(life: LifeState, player: PlayerState, choice: number): void {
  player.px = life.homeX * TILE + TILE / 2;
  player.py = life.homeY * TILE + TILE / 2;
  player.pSpeed = 0;
  player.pAngle = -Math.PI / 2;
  life.broken = false;
  life.breakdownType = '';
  life.breakdownTimer = 0;

  if (choice === 1) {
    // Mechanic tow — bring stats up to the bare-drivable floor so
    // the player isn't instantly broken again. Matches monolith
    // L8802-L8805.
    life.engine = Math.max(life.engine, 15);
    life.tires  = Math.max(life.tires,  10);
    life.carHP  = Math.max(life.carHP,  10);
    life.fuel   = Math.max(life.fuel,   10);
    setNotifState(life, 'Towed to mechanic — car is drivable.', 240);
  } else {
    setNotifState(life, 'Towed home. Car needs repairs.', 240);
  }

  life.incomingTow = null;
}
