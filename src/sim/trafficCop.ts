/**
 * H704: TRAFFIC COP job sim — radar → chase → bump → ticket loop.
 *
 * The player picks the TRAFFIC COP job on the JOBS tab. On pickup
 * `life.copJob` gets seeded as `{phase:'radar', ...}`. From there:
 *
 *   - 'radar'   Player must park (|pSpeed|<2). Every 8-20 seconds
 *               a forward-cone scan (~30° half, 3-25 tiles) picks
 *               a non-cop traffic car and surfaces a notif +
 *               populates cj.alertCarIdx. Player presses ACCEPT
 *               (acceptCopAlert) to flip to 'chasing'. Driving off
 *               clears any pending alert.
 *   - 'chasing' Target speeds up to 1.4× its base speed after a
 *               3-sec grace period (so the player can close).
 *               Player must rear-end the target (within 2.2 tiles
 *               AND in front of player within ~60° cone). Bump
 *               flips to 'bumped'. If the target drifts >120 tiles
 *               away it escapes; phase resets to 'radar'.
 *   - 'bumped'  Target stops at the pullover position. Player must
 *               park within 5 tiles. Pressing ISSUE TICKET
 *               (issueTrafficTicket) pays a $50-200 bonus, clears
 *               the job, and ends the shift.
 *
 * 1:1 port of monolith L27600-L27794 with these intentional
 * adaptations for the modular tree:
 *
 *   - TrafficCar uses px/py/pAngle/baseSpeed (not x/y/angle/
 *     maxSpeed). Field renames threaded through.
 *   - Modular traffic is fixed-N and never despawns, so the
 *     "force respawn a nearby car for radar coverage" branch
 *     (monolith L27613-L27650) is dropped. The fixed-N spawn
 *     already keeps cars in range.
 *   - TrafficCar has no bodyType field. Alert description
 *     collapses to "Vehicle" (the monolith's _bodyNames
 *     fallback). Per-body flavor names port when the modular
 *     traffic gets a bodyType field.
 *   - No road-name speed-limit lookup. Default 35mph everywhere
 *     for the alert's "doing X in Y" line. Highway 65mph
 *     re-introduces when BASELINE_ROADS name lookup ports.
 *
 * The cop-sim mutates three new optional fields on TrafficCar
 * (_copTargeted, _copSlowTimer, _copStuck) — see the TrafficCar
 * type in state/traffic.ts. They're inert when no cop sim is
 * running (default-undefined).
 */

import type { LifeState } from '@/state/life';
import type { PlayerState } from '@/state/player';
import type { TrafficCar } from '@/state/traffic';
import { TILE } from '@/config/world/tiles';
import { SCALE_MS } from '@/physics/physicsUnits';
import { showNotif } from '@/ui/notif';

/** Cop-sim phase. */
export type CopPhase = 'radar' | 'chasing' | 'bumped';

/** Full cop-sim state. Stored on `life.copJob`. The render lib
 *  (src/render/trafficCop.ts) reads a structural subset; this is
 *  the canonical shape the sim owns. */
export interface CopJobState {
  phase: CopPhase;
  /** Target car index during 'chasing'/'bumped'. -1 when no target. */
  targetIdx: number;
  /** Ticket pay seed — copied from life.job.pay at job pickup. The
   *  H704 sim uses a flat $50-200 random bonus on ticket issue;
   *  ticketPay is preserved for parity with the monolith schema. */
  ticketPay: number;
  /** Seconds-since-last-alert during 'radar' & parked. Resets on
   *  fire OR on driving off. */
  alertTimer: number;
  /** Forward-cone scan result. -1 when no alert pending. Cleared
   *  to -1 on accept (the value moves to targetIdx) or on drive-off. */
  alertCarIdx: number;
  // Alert-line flavor (set when alertCarIdx changes from -1).
  _alertSpeed?: number;
  _alertLimit?: number;
  _alertCarDesc?: string;
  _alertCarColor?: string;
  // Pullover anchor (set when 'chasing' transitions to 'bumped').
  _pulloverX?: number;
  _pulloverY?: number;
  _pulloverAngle?: number;
}

/** Per-frame readout for the HUD/render layer — slim view derived
 *  from `life.copJob` without forcing a cast at the call site. */
export function getCopJob(life: LifeState): CopJobState | null {
  const cj = life.copJob as CopJobState | undefined | null;
  return cj ?? null;
}

/** Seed the cop-sim state. Called by the job-pickup site once
 *  life.playerJob === 'TRAFFIC COP' AND life.job has been
 *  selected. Mirrors monolith L21204 / L21769 / L46803. */
export function startCopJob(life: LifeState): void {
  const pay = life.job?.pay ?? 0;
  life.copJob = {
    phase: 'radar',
    targetIdx: -1,
    ticketPay: pay,
    alertTimer: 0,
    alertCarIdx: -1,
  } as CopJobState;
}

/** Radar timer min — first scan fires this many seconds after
 *  arriving at radar idle. Matches monolith L27652 `8`. */
const ALERT_MIN_SECS = 8;
/** Radar timer jitter range. Total window is [ALERT_MIN,
 *  ALERT_MIN+ALERT_JITTER]. Matches monolith L27652 `12`. */
const ALERT_JITTER_SECS = 12;
/** Forward-cone half-angle (dot-product cutoff) for radar pick.
 *  0.85 ≈ 32° half-angle. Matches monolith L27665. */
const RADAR_CONE_DOT = 0.85;
/** Minimum & maximum scan distance (tiles). Matches L27662. */
const RADAR_MIN_TILES = 3;
const RADAR_MAX_TILES = 25;
/** Speeder grace period — target maintains base speed for this
 *  many seconds before fleeing at 1.4× base. Matches monolith
 *  L27694 `3.0`. */
const SPEEDER_GRACE_SECS = 3;
/** Bump-detection radius (tiles). Matches L27726 `2.2`. */
const BUMP_RADIUS_TILES = 2.2;
/** Bump-detection forward cone — target must lie within this
 *  many radians of the player's heading. ~60° on either side.
 *  Matches L27732 `1.05`. */
const BUMP_CONE_RADIANS = 1.05;
/** Escape distance (tiles). Target lost when farther than this.
 *  Matches monolith L27742 `120`. */
const ESCAPE_DIST_TILES = 120;
/** Ticket-issue proximity (tiles). Player must be within this
 *  distance of the pullover anchor. Matches L27767 `5`. */
const TICKET_NEAR_TILES = 5;
/** Ticket-issue speed cap. Player must be slower than this
 *  (wpx/s). Matches L27768 `3`. */
const TICKET_SPEED_CAP = 3;
/** Ticket bonus range — flat $50 + uniform $0-$150. Matches
 *  monolith L27770 `50+Math.floor(Math.random()*151)`. */
const TICKET_BONUS_MIN = 50;
const TICKET_BONUS_RANGE = 151;
/** Default speed-limit for alert flavor (mph). Modular doesn't
 *  yet expose per-road limits; the monolith branched on road
 *  name. 35 mph is the city default. */
const DEFAULT_LIMIT_MPH = 35;
/** Speeder over-amount range — alert claims target is doing
 *  10-25 over the limit. Matches monolith L27677. */
const OVER_MIN_MPH = 10;
const OVER_RANGE_MPH = 16;

/**
 * Advance the cop sim one frame. Called from the main game loop;
 * no-op when the player isn't on the TRAFFIC COP job. Mirrors
 * monolith updateTrafficCop at L27600-L27757.
 */
export function tickTrafficCop(
  life: LifeState,
  player: PlayerState,
  traffic: TrafficCar[],
  dt: number,
): void {
  if (life.playerJob !== 'TRAFFIC COP' || life.jobDoneToday) return;
  const cj = life.copJob as CopJobState | undefined | null;
  if (!cj) return;

  const { px, py, pAngle, pSpeed } = player;
  const playerStopped = Math.abs(pSpeed) < 2;

  if (cj.phase === 'radar') {
    if (playerStopped) {
      cj.alertTimer += dt;
      // Fire a scan every ALERT_MIN+rand(0..ALERT_JITTER) seconds.
      if (cj.alertTimer > ALERT_MIN_SECS + Math.random() * ALERT_JITTER_SECS) {
        cj.alertTimer = 0;
        scanForSpeeder(cj, traffic, px, py, pAngle);
      }
    } else {
      cj.alertTimer = 0;
      // Driving off clears any pending alert — the player chose
      // not to engage.
      if (cj.alertCarIdx >= 0) {
        const prev = traffic[cj.alertCarIdx];
        if (prev) prev._copTargeted = false;
        cj.alertCarIdx = -1;
      }
    }
    return;
  }

  if (cj.phase === 'chasing') {
    const ti = cj.targetIdx;
    if (ti < 0 || ti >= traffic.length) {
      escapeBack(cj, life);
      return;
    }
    const t = traffic[ti];
    // Grace period then full flee speed.
    const slowLeft = t._copSlowTimer ?? 0;
    if (slowLeft > 0) {
      t._copSlowTimer = slowLeft - dt;
    } else {
      t.speed = Math.max(t.speed, t.baseSpeed * 1.4);
    }
    const dx = t.px - px;
    const dy = t.py - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Bump trigger — close enough AND target ahead of player AND
    // player moving.
    if (dist < TILE * BUMP_RADIUS_TILES && Math.abs(pSpeed) > 1) {
      const toTargetAngle = Math.atan2(dy, dx);
      let angleDiff = toTargetAngle - pAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      if (Math.abs(angleDiff) < BUMP_CONE_RADIANS) {
        cj.phase = 'bumped';
        cj._pulloverX = t.px;
        cj._pulloverY = t.py;
        cj._pulloverAngle = t.pAngle;
        t.speed = 0;
        t._copStuck = true;
        // Player decelerates from the contact (monolith mutates
        // pSpeed directly; modular slows via player.pSpeed).
        player.pSpeed = player.pSpeed * 0.3;
        showNotif(life, '🚔 PULLED OVER! Stop near them to issue ticket.');
        return;
      }
    }
    // Escape — target drifted out of range.
    if (dist > TILE * ESCAPE_DIST_TILES) {
      t._copTargeted = false;
      escapeBack(cj, life);
    }
    return;
  }

  if (cj.phase === 'bumped') {
    // Pin the target at the pullover anchor. Without this, the
    // traffic tick keeps advancing the car along its road.
    const ti = cj.targetIdx;
    if (ti >= 0 && ti < traffic.length) {
      const t = traffic[ti];
      if (cj._pulloverX !== undefined) t.px = cj._pulloverX;
      if (cj._pulloverY !== undefined) t.py = cj._pulloverY;
      if (cj._pulloverAngle !== undefined) t.pAngle = cj._pulloverAngle;
      t.speed = 0;
    }
  }
}

/** Forward-cone scan during 'radar' & parked. Picks the closest
 *  non-cop traffic car within the cone+range and populates the
 *  alert fields. */
function scanForSpeeder(
  cj: CopJobState,
  traffic: TrafficCar[],
  px: number,
  py: number,
  pAngle: number,
): void {
  const cosFwd = Math.cos(pAngle);
  const sinFwd = Math.sin(pAngle);
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < traffic.length; i++) {
    const t = traffic[i];
    if (t.isCop) continue;
    const dx = t.px - px;
    const dy = t.py - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > TILE * RADAR_MAX_TILES || dist < TILE * RADAR_MIN_TILES) continue;
    const dot = (dx * cosFwd + dy * sinFwd) / dist;
    if (dot > RADAR_CONE_DOT && dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  if (bestIdx < 0) return;
  const t = traffic[bestIdx];
  const tSpeedMph = (t.speed / SCALE_MS) * 2.237;
  void tSpeedMph; // monolith reads but doesn't display — preserved for parity
  const limit = DEFAULT_LIMIT_MPH;
  const overAmount = OVER_MIN_MPH + Math.floor(Math.random() * OVER_RANGE_MPH);
  const claimedSpeed = limit + overAmount;
  cj.alertCarIdx = bestIdx;
  cj._alertSpeed = claimedSpeed;
  cj._alertLimit = limit;
  cj._alertCarDesc = 'Vehicle';
  cj._alertCarColor = t.color ?? '#888';
  t._copTargeted = true;
  t._copSlowTimer = SPEEDER_GRACE_SECS;
}

/** Reset back to radar after target loss. */
function escapeBack(cj: CopJobState, life: LifeState): void {
  showNotif(life, 'Speeder escaped! Resuming radar.');
  cj.phase = 'radar';
  cj.targetIdx = -1;
  cj.alertTimer = 0;
}

/** Player pressed ACCEPT during a pending radar alert. Flip the
 *  phase machine to 'chasing' with the alerted car as target.
 *  Mirrors monolith acceptCopAlert at L27787. No-op when no
 *  pending alert. */
export function acceptCopAlert(life: LifeState): void {
  const cj = life.copJob as CopJobState | undefined | null;
  if (!cj || cj.phase !== 'radar' || cj.alertCarIdx < 0) return;
  cj.phase = 'chasing';
  cj.targetIdx = cj.alertCarIdx;
  cj.alertCarIdx = -1;
  showNotif(life, '🚔 LIGHTS ON! Chase the speeder!');
}

/** Player pressed ISSUE TICKET while in 'bumped' phase. Pays a
 *  $50-200 bonus and ends the shift. Guards on proximity + speed
 *  before issuing — bails with a hint notif on either fail.
 *  Mirrors monolith issueTrafficTicket at L27760. */
export function issueTrafficTicket(life: LifeState, player: PlayerState, traffic: TrafficCar[]): void {
  const cj = life.copJob as CopJobState | undefined | null;
  if (!cj || cj.phase !== 'bumped') return;
  if (cj._pulloverX !== undefined && cj._pulloverY !== undefined) {
    const pdx = player.px - cj._pulloverX;
    const pdy = player.py - cj._pulloverY;
    const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
    if (pdist > TILE * TICKET_NEAR_TILES) {
      showNotif(life, 'Get closer to the pulled-over car!');
      return;
    }
    if (Math.abs(player.pSpeed) > TICKET_SPEED_CAP) {
      showNotif(life, 'Stop your car first!');
      return;
    }
  }
  const bonus = TICKET_BONUS_MIN + Math.floor(Math.random() * TICKET_BONUS_RANGE);
  life.money += bonus;
  // Release the target so it can resume traffic motion.
  const ti = cj.targetIdx;
  if (ti >= 0 && ti < traffic.length) {
    const t = traffic[ti];
    t._copTargeted = false;
    t._copStuck = false;
    t._copSlowTimer = 0;
    t.speed = t.baseSpeed;
  }
  life.copJob = null;
  life.job = null;
  life.jobDoneToday = true;
  showNotif(life, '🎫 TICKET ISSUED! +$' + bonus + ' bonus. Done for the day.');
}
