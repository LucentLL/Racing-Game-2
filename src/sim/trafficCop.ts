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
 *               TWO ways to pull the target over:
 *                 (a) H1126 YIELD — tail them (within 6 tiles,
 *                     inside the ~60° heading cone) for ~4s of
 *                     sustained pursuit → they signal and pull
 *                     over on their own ('yielding').
 *                 (b) RAM — rear-end the target (within 2.2 tiles
 *                     AND in front within ~60° cone) → 'bumped'
 *                     immediately (the forceful alternative).
 *               If the target drifts >120 tiles away it escapes;
 *               phase resets to 'radar'.
 *   - 'yielding' H1126: target decelerates to a stop under the
 *               sim's control (the cop-sim ticks AFTER tickTraffic,
 *               so its speed writes win the frame). At rest the
 *               phase joins the normal 'bumped' pin + ticket flow.
 *               A ram during the slow-down still pins instantly.
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
export type CopPhase = 'radar' | 'chasing' | 'yielding' | 'bumped';

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
   *  fire OR on driving off. H1125: motion PAUSES it; only a
   *  deliberate drive-off (see _driveOffPx) zeroes it. */
  alertTimer: number;
  /** H1125: distance accumulated while moving during 'radar' (world
   *  px). Crossing DRIVE_OFF_PX = the player left the trap on
   *  purpose → timer + pending alert reset. Traffic bumps and idle
   *  creep never accumulate enough to trip it. */
  _driveOffPx?: number;
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
  /** H1126: seconds of sustained tailing during 'chasing' (within
   *  YIELD_RADIUS_TILES + heading cone, post-grace). Decays at 2×
   *  when the tail is broken so traffic-weave jitter doesn't hard-
   *  reset an honest pursuit. At YIELD_AFTER_SECS → 'yielding'. */
  _yieldTimer?: number;
  /** H1126: the sim-owned target speed during 'yielding'. tickTraffic
   *  blends car.speed toward baseSpeed every frame (state/traffic.ts
   *  ~:1014) — at low speeds that pull exceeds any decel applied to
   *  car.speed itself, so the car would creep forever. Ratcheting our
   *  own copy down and assigning it AFTER tickTraffic wins the frame. */
  _yieldSpeed?: number;
  /** H1189: the target speed at the instant 'yielding' began — the
   *  denominator for the shoulder-drift ramp (0 at yield start → 1 at
   *  full stop). */
  _yieldInitSpeed?: number;
  /** H1189: this target FLEES rather than pulling over — set at accept
   *  (FLEE_CHANCE). The chase yield-trigger is skipped, so only a ram
   *  or an escape ends it. */
  _targetFlees?: boolean;
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
/** H1125: travel distance (world px) that counts as deliberately
 *  leaving the radar trap — ~3 tiles. Bumps + idle creep stay far
 *  below this before the car re-settles. */
const DRIVE_OFF_PX = 54;

/** H1126: tail radius (tiles) — player must stay this close behind
 *  the target for the yield timer to accumulate. */
const YIELD_RADIUS_TILES = 6;
/** H1126: sustained-tail seconds before the target gives up and
 *  pulls over on its own. */
const YIELD_AFTER_SECS = 4;
/** H1126: yielding deceleration (world-px/s²). Flee speed tops out
 *  ~235 wpx/s (168 max base × 1.4) → full stop in under 2s. */
const YIELD_DECEL = 120;
/** H1126: _yieldSpeed at/below this (wpx/s) counts as stopped —
 *  transition 'yielding' → 'bumped' (pin + ticket flow). */
const YIELD_STOP_SPEED = 2;
/** H1189: how far the yielding target drifts toward the shoulder as it
 *  decelerates, as a fraction of the road's asphalt width. syncPose
 *  already sits the car at 0.25·width (right-lane center); +0.18 lands
 *  it at ~0.43·width — hard against the right edge — so it reads as
 *  "pulled onto the shoulder" instead of stopping dead in the lane. */
const SHOULDER_DRIFT_FRAC = 0.18;
/** H1189: fallback road width (wpx) if a target has none cached. */
const SHOULDER_FALLBACK_WPX = TILE * 5;
/** H1189: fraction of accepted targets that FLEE instead of yielding —
 *  they keep running at flee speed and can only be stopped by a ram
 *  (or lost past the escape distance), so a chase isn't always a
 *  guaranteed courteous pull-over. */
const FLEE_CHANCE = 0.35;

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
      cj._driveOffPx = 0;
      // Fire a scan every ALERT_MIN+rand(0..ALERT_JITTER) seconds.
      if (cj.alertTimer > ALERT_MIN_SECS + Math.random() * ALERT_JITTER_SECS) {
        cj.alertTimer = 0;
        scanForSpeeder(cj, traffic, px, py, pAngle);
      }
    } else {
      // H1125: motion used to ZERO the timer instantly — but passing
      // traffic rear-ends a parked cruiser (verified headless: pSpeed
      // spiked to 67 from bumps at a realistic trap spot), so the
      // 8-20s continuous-stillness window never completed and radar
      // NEVER fired (user bug: "radar doesn't work when parked").
      // Now motion only PAUSES accumulation; the timer + any pending
      // alert reset only after a deliberate drive-off.
      cj._driveOffPx = (cj._driveOffPx ?? 0) + Math.abs(pSpeed) * dt;
      if (cj._driveOffPx > DRIVE_OFF_PX) {
        cj._driveOffPx = 0;
        cj.alertTimer = 0;
        if (cj.alertCarIdx >= 0) {
          const prev = traffic[cj.alertCarIdx];
          if (prev) prev._copTargeted = false;
          cj.alertCarIdx = -1;
        }
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
    // Heading cone — shared by the bump trigger and the H1126 tail
    // check (both need "target ahead of the player").
    const toTargetAngle = Math.atan2(dy, dx);
    let angleDiff = toTargetAngle - pAngle;
    while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
    while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
    const targetAhead = Math.abs(angleDiff) < BUMP_CONE_RADIANS;
    // Bump trigger — close enough AND target ahead of player AND
    // player moving. The forceful pull-over.
    if (dist < TILE * BUMP_RADIUS_TILES && Math.abs(pSpeed) > 1 && targetAhead) {
      pinTarget(cj, t, player, life);
      return;
    }
    // H1126: yield trigger — the courteous pull-over. Post-grace
    // (target actively fleeing), player holding within 6 tiles and
    // the heading cone accumulates the tail timer; a broken tail
    // decays it at 2× instead of hard-resetting so a lane weave
    // doesn't zero an honest pursuit.
    // H1189: FLEE-type targets never yield — they run until rammed or
    // lost. Only courteous (non-flee) targets accumulate the tail timer.
    if (!cj._targetFlees && slowLeft <= 0 && dist < TILE * YIELD_RADIUS_TILES && targetAhead) {
      cj._yieldTimer = (cj._yieldTimer ?? 0) + dt;
      if (cj._yieldTimer >= YIELD_AFTER_SECS) {
        cj.phase = 'yielding';
        cj._yieldTimer = 0;
        cj._yieldSpeed = t.speed;
        cj._yieldInitSpeed = Math.max(t.speed, 1);
        showNotif(life, '🚦 They\'re pulling over — stay behind them!');
        return;
      }
    } else if (cj._yieldTimer) {
      cj._yieldTimer = Math.max(0, cj._yieldTimer - dt * 2);
    }
    // Escape — target drifted out of range.
    if (dist > TILE * ESCAPE_DIST_TILES) {
      t._copTargeted = false;
      escapeBack(cj, life);
    }
    return;
  }

  if (cj.phase === 'yielding') {
    const ti = cj.targetIdx;
    if (ti < 0 || ti >= traffic.length) {
      escapeBack(cj, life);
      return;
    }
    const t = traffic[ti];
    // Ratchet the sim-owned speed down and overwrite car.speed —
    // this tick runs after tickTraffic, so the write wins the frame
    // (see _yieldSpeed doc for why decrementing car.speed directly
    // never reaches zero).
    const ys = Math.max(0, (cj._yieldSpeed ?? t.speed) - YIELD_DECEL * dt);
    cj._yieldSpeed = ys;
    t.speed = ys;
    // H1189: DRIFT TO THE SHOULDER as it slows. tickTraffic already ran
    // this frame and reset px/py to the lane centerline (+kx/ky), so we
    // add a rightward perpendicular offset ON TOP — in the SAME direction
    // syncPose applies its 0.25·width lane offset (−perp, perp=(uy,−ux)),
    // ramped by how far the car has decelerated. The car ends hard
    // against the right edge instead of stopped dead-center.
    const prog = Math.min(1, 1 - ys / (cj._yieldInitSpeed ?? Math.max(ys, 1)));
    const ux = Math.cos(t.pAngle), uy = Math.sin(t.pAngle);
    const off = (t.roadWidthWpx || SHOULDER_FALLBACK_WPX) * SHOULDER_DRIFT_FRAC * prog;
    t.px -= uy * off;      // perpX = uy
    t.py -= -ux * off;     // perpY = −ux
    // A ram during the slow-down still pins instantly (same trigger
    // as 'chasing').
    const dx = t.px - px;
    const dy = t.py - py;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < TILE * BUMP_RADIUS_TILES && Math.abs(pSpeed) > 1) {
      const toTargetAngle = Math.atan2(dy, dx);
      let angleDiff = toTargetAngle - pAngle;
      while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
      if (Math.abs(angleDiff) < BUMP_CONE_RADIANS) {
        pinTarget(cj, t, player, life);
        return;
      }
    }
    // Rolled to a stop → join the normal pin + ticket flow.
    if (ys <= YIELD_STOP_SPEED) {
      pinTarget(cj, t, player, life);
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

/** Pin the target at its current pose and enter 'bumped' (the
 *  shared pull-over end-state for both the ram and the H1126 yield
 *  path). Ram contact slows the player 0.3× (monolith parity);
 *  a contactless yield-stop must NOT jerk the player's car, so the
 *  slowdown only applies when the player is inside bump range. */
function pinTarget(
  cj: CopJobState,
  t: TrafficCar,
  player: PlayerState,
  life: LifeState,
): void {
  cj.phase = 'bumped';
  cj._pulloverX = t.px;
  cj._pulloverY = t.py;
  cj._pulloverAngle = t.pAngle;
  cj._yieldTimer = 0;
  cj._yieldSpeed = undefined;
  cj._yieldInitSpeed = undefined;
  t.speed = 0;
  t._copStuck = true;
  const dx = t.px - player.px;
  const dy = t.py - player.py;
  if (dx * dx + dy * dy < TILE * TILE * BUMP_RADIUS_TILES * BUMP_RADIUS_TILES) {
    // Player decelerates from the contact (monolith mutates
    // pSpeed directly; modular slows via player.pSpeed).
    player.pSpeed = player.pSpeed * 0.3;
  }
  showNotif(life, '🚔 PULLED OVER! Stop near them to issue ticket.');
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
  cj._yieldTimer = 0;
  cj._yieldSpeed = undefined;
  cj._yieldInitSpeed = undefined;
  cj._targetFlees = false;
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
  // H1189: roll for a runner. Fleers never yield — the player must ram.
  cj._targetFlees = Math.random() < FLEE_CHANCE;
  cj._yieldInitSpeed = undefined;
  showNotif(life, cj._targetFlees
    ? '🚔 LIGHTS ON! They\'re running — cut them off!'
    : '🚔 LIGHTS ON! Chase the speeder!');
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
