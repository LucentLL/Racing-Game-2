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
 *   - 'departing' truck drives off along departDir at 1.2× speed
 *                 with the player hidden inside. After 8s or 50-tile
 *                 distance, fires finishIncomingTow which warps the
 *                 player home + clears the broken state.
 *
 * 1:1 with monolith semantics; only difference is the modular
 * doesn't yet pipe the truck through drawTow (render is wired but
 * gameLoop's draw path uses drawPlayerCarV2 directly, not the
 * render/index.ts orchestrator). The tick still runs the geometry
 * forward so when the render hop lands the truck animation works
 * without re-instrumenting state. Until then the player sees the
 * notifs + the home warp.
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import { SCALE_MS } from '@/physics/physicsUnits';
import { TILE } from '@/config/world/tiles';
import { showNotif as setNotifState } from '@/ui/notif';

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
}

/** Advance the incoming-tow state one frame. No-op when
 *  life.incomingTow is unset. Caller runs this every tick — cheap
 *  when idle (single null check). */
export function tickIncomingTow(
  life: LifeState,
  player: PlayerState,
  dt: number,
): void {
  const t = life.incomingTow as IncomingTowState | undefined | null;
  if (!t) return;

  if (t.phase === 'arriving') {
    const dx = t.parkX - t.x;
    const dy = t.parkY - t.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    t.angle = t.arriveAngle;
    if (dist > TOW_APPROACH_SPEED * dt) {
      t.x += Math.cos(t.arriveAngle) * TOW_APPROACH_SPEED * dt;
      t.y += Math.sin(t.arriveAngle) * TOW_APPROACH_SPEED * dt;
    } else {
      t.x = t.parkX;
      t.y = t.parkY;
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
    // Player rides inside the truck.
    player.px = t.x;
    player.py = t.y;
    player.pSpeed = 0;
    t.x += Math.cos(t.departDir) * TOW_APPROACH_SPEED * 1.2 * dt;
    t.y += Math.sin(t.departDir) * TOW_APPROACH_SPEED * 1.2 * dt;
    t.angle = t.departDir;
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
