/**
 * H1014/H1016/H1018: track races on the test maps — a timed run (solo) that
 * becomes a head-to-head vs an AI rival with street-rep progression.
 *
 * Auto-starts at the staging line: drive in slow -> the rival appears STAGED
 * beside you -> 3-2-1 -> GO. A tier-matched opponent (generateRaceOpponent)
 * is driven by the player's EXACT longitudinal physics (advanceOppPhysics)
 * and steered along the track geometry (straight down the drag strip in the
 * adjacent lane / around the oval ellipse in the inner lane). First to the
 * finish wins; the result feeds the SAME street-rep ladder the city uses.
 * Returning to staging re-arms with a fresh rival.
 *
 * Separate from the city's sim/race.ts. Module singleton, reset on map switch.
 */
import { getMapDef, type TrackRaceSpec } from '@/world/mapRegistry';
import { getActiveMapId } from '@/world/mapRuntime';
import { TILE, WPX_PER_M } from '@/config/world/tiles';
import { generateRaceOpponent, advanceOppPhysics, type OppPhysState } from '@/sim/race';
import { CAR_CATALOG } from '@/config/cars/catalog';
import { getStreetTier, STREET_TIER_WIN_REP_GAIN, STREET_TIER_LOSS_REP_GAIN } from '@/sim/streetTier';
import { BLACKLIST_RIVALS, ensureBlacklistState } from '@/config/blacklist';
import { pushPage } from '@/ui/hud/pager';
import type { LifeState } from '@/state/life';

export type TrackRacePhase = 'idle' | 'countdown' | 'running' | 'done';

export interface TrackRaceOpp {
  id: string;
  name: string;
  x: number; y: number; angle: number; // world px / radians
  phys: OppPhysState;
  topSpeed: number;
  dist: number;   // drag: distance travelled from launch (wpx)
  theta: number;  // oval: angle around the ellipse
  lap: number;    // oval
  finished: boolean;
}

export interface TrackRaceRun {
  mapId: string;
  spec: TrackRaceSpec;
  phase: TrackRacePhase;
  countdown: number;
  elapsed: number;
  startX: number;
  startY: number;
  lap: number;
  lapStart: number;
  bestLap: number | null;
  leftStart: boolean;
  result: string | null;
  opp: TrackRaceOpp | null;
  winner: 'player' | 'opponent' | null;
  repGain: number;
  /** H1029: money won this race (0 on loss). */
  prizeMoneyGain: number;
  /** H1029: true once the player has used their one race for the day — staging
   *  won't re-arm and the HUD shows a come-back-tomorrow prompt. */
  racedToday: boolean;
  /** H1034: a CAR MEET challenge — a drag race vs a SPECIFIC parked car,
   *  UNLIMITED (doesn't stamp/consult the daily lastRaceDay cap). */
  challenge?: boolean;
  /** H1079 (BL-3): set when the challenged car is a blacklist rival's —
   *  a win records the rank on life.blacklist.defeated. */
  blRank?: number;
  /** H1020: countdown-baseline position — a false start is leaving it before
   *  GO (unless holding the e-brake, which is a legit launch hold). */
  stageX: number;
  stageY: number;
  /** Transient warning banner (e.g. JUMP START) + its remaining display time. */
  warning: string | null;
  warnTimer: number;
}

let run: TrackRaceRun | null = null;

const STAGE_SPEED = 45;      // near-stopped to arm (wpx/s)
const COUNTDOWN_S = 3;
const FALSE_START_TOL = 1.2 * TILE;  // leaving the line before GO = jump start
const LANE_HALF = 0.64;       // half a lane in tiles (racers stage one per lane)
const OVAL_LANE_TILES = 1.3;  // opponent runs one lane inside the player's line

/** Oval opponent cornering cap (fraction of its top speed) so a tight loop is
 *  beatable — the AI follows the ellipse on rails, so without this it would
 *  corner at top speed. Tunable. */
const OVAL_SPEED_FRAC = 0.6;

export function getTrackRaceRun(): TrackRaceRun | null {
  return run;
}
export function resetTrackRace(): void {
  run = null;
}

/** H1034: where the challenger (player) lines up for a meet drag — the strip
 *  start, LEFT lane, nose +y. null if the active map has no drag spec. The
 *  caller feeds this to resetPlayerMotion before startMeetChallenge. */
export function meetPlayerStart(): { x: number; y: number; angle: number } | null {
  const spec = getMapDef(getActiveMapId()).race;
  if (!spec || spec.kind !== 'drag') return null;
  return {
    x: (spec.startTile[0] - LANE_HALF) * TILE,
    y: (spec.startTile[1] + 0.5) * TILE,
    angle: Math.PI / 2,
  };
}

/** H1034: arm a CAR MEET challenge — a drag race vs a SPECIFIC parked car,
 *  UNLIMITED (doesn't touch the daily cap). The caller has already teleported
 *  the player to meetPlayerStart() (left lane, nose +y). We build the drag run
 *  from the active map's spec, spawn the chosen opponent in the RIGHT lane
 *  level with the player, and drop straight into the countdown. */
export function startMeetChallenge(opponentId: string, playerPx: number, playerPy: number, life: LifeState | null, blRank?: number): void {
  const mapId = getActiveMapId();
  const spec = getMapDef(mapId).race;
  if (!spec || spec.kind !== 'drag') return;
  const car = CAR_CATALOG[opponentId];
  if (!car) return;
  // H1079: count the attempt against the rival (win or lose).
  if (blRank != null && life) {
    const bl = ensureBlacklistState(life);
    bl.attempts[blRank] = (bl.attempts[blRank] ?? 0) + 1;
  }
  run = {
    mapId, spec, phase: 'countdown', countdown: COUNTDOWN_S, elapsed: 0,
    startX: 0, startY: 0, lap: 0, lapStart: 0, bestLap: null, leftStart: false,
    result: null, opp: null, winner: null, repGain: 0, prizeMoneyGain: 0,
    racedToday: false, stageX: playerPx, stageY: playerPy, warning: null, warnTimer: 0,
    challenge: true, blRank,
  };
  run.opp = {
    id: opponentId, name: car.name,
    x: (spec.startTile[0] + LANE_HALF) * TILE, y: playerPy, angle: Math.PI / 2,
    phys: { speed: 0, rpm: 900, gear: 1, shiftTimer: 0 },
    topSpeed: car.topSpeed, dist: 0, theta: 0, lap: 0, finished: false,
  };
}

function playerCarIdOf(life: LifeState | null): string {
  return life?.ownedCars?.[0] ?? '';
}

/** Spawn the tier-matched rival STAGED next to the player (not moving), ready
 *  for the countdown. Null if no match. */
function spawnOpponent(spec: TrackRaceSpec, playerY: number, life: LifeState | null): TrackRaceOpp | null {
  const oppId = generateRaceOpponent(playerCarIdOf(life));
  if (!oppId) return null;
  const car = CAR_CATALOG[oppId];
  if (!car) return null;
  const opp: TrackRaceOpp = {
    id: oppId,
    name: car.name,
    x: 0, y: 0, angle: Math.PI / 2,
    phys: { speed: 0, rpm: 900, gear: 1, shiftTimer: 0 },
    topSpeed: car.topSpeed,
    dist: 0, theta: 0, lap: 0, finished: false,
  };
  if (spec.kind === 'drag') {
    // Right lane, on the start line beside the player (who stages left).
    opp.x = (spec.startTile[0] + LANE_HALF) * TILE;
    opp.y = playerY;
  } else if (spec.ovalCenter) {
    // Inner lane at the start line (theta 0), beside the player's outer line.
    const innerRx = (spec.ovalRx ?? 60) - OVAL_LANE_TILES;
    opp.theta = 0;
    opp.x = (spec.ovalCenter[0] + innerRx) * TILE;
    opp.y = spec.ovalCenter[1] * TILE;
  }
  return opp;
}

/** Advance the rival one frame (physics + steering along the track). */
function advanceOpp(o: TrackRaceOpp, spec: TrackRaceSpec, launchY: number, dt: number): void {
  const car = CAR_CATALOG[o.id];
  if (!car) return;
  advanceOppPhysics(o.phys, car, dt);
  if (spec.kind === 'drag') {
    o.angle = Math.PI / 2;
    o.y += o.phys.speed * dt;
    o.dist = o.y - launchY;
    if (o.dist >= (spec.meters ?? 402) * WPX_PER_M) o.finished = true;
    return;
  }
  // oval: advance along the INNER ellipse by arc length, cornering-capped.
  if (!spec.ovalCenter) return;
  const cx = spec.ovalCenter[0] * TILE, cy = spec.ovalCenter[1] * TILE;
  const rx = ((spec.ovalRx ?? 60) - OVAL_LANE_TILES) * TILE;
  const ry = ((spec.ovalRy ?? 40) - OVAL_LANE_TILES) * TILE;
  const cap = o.topSpeed * OVAL_SPEED_FRAC;
  if (o.phys.speed > cap) o.phys.speed = cap;
  const st = Math.sin(o.theta), ct = Math.cos(o.theta);
  const dsdTheta = Math.hypot(rx * st, ry * ct) || 1;
  o.theta += (o.phys.speed * dt) / dsdTheta;
  o.x = cx + rx * Math.cos(o.theta);
  o.y = cy + ry * Math.sin(o.theta);
  o.angle = Math.atan2(ry * Math.cos(o.theta), -rx * Math.sin(o.theta));
  const laps = Math.floor(o.theta / (Math.PI * 2));
  if (laps > o.lap) o.lap = laps;
  if (o.lap >= (spec.laps ?? 3)) o.finished = true;
}

/** Tier-scaled win prize (inverse of the rep curve): the climb pays big early
 *  then thins out — money matters more before the player is established. */
const WIN_PRIZE = [500, 300, 150, 75] as const;

function applyProgression(life: LifeState, day: number, win: boolean, unlimited: boolean): { repGain: number; prizeGain: number } {
  const tier = getStreetTier(life);
  life.streetRacesTotal = (life.streetRacesTotal ?? 0) + 1;
  // H1034: meet challenges are unlimited — they still award rep/money but do
  // NOT burn the one-street-race-per-day cap (shared life.lastRaceDay).
  if (!unlimited) life.lastRaceDay = day;
  let repGain: number;
  let prizeGain = 0;
  if (win) {
    life.streetRacesWon = (life.streetRacesWon ?? 0) + 1;
    repGain = STREET_TIER_WIN_REP_GAIN[tier.idx as 0 | 1 | 2 | 3];
    prizeGain = WIN_PRIZE[tier.idx as 0 | 1 | 2 | 3];
    life.money = (life.money ?? 0) + prizeGain;
  } else {
    repGain = STREET_TIER_LOSS_REP_GAIN;
  }
  life.streetRep = Math.min(100, (life.streetRep ?? 0) + repGain);
  return { repGain, prizeGain };
}

function finishRun(r: TrackRaceRun, life: LifeState | null, day: number, playerWon: boolean): void {
  const timeStr = r.spec.kind === 'drag'
    ? `${r.elapsed.toFixed(2)}s`
    : `${r.elapsed.toFixed(2)}s · best ${(r.bestLap ?? r.elapsed).toFixed(2)}s`;
  if (r.opp && life) {
    r.winner = playerWon ? 'player' : 'opponent';
    const { repGain, prizeGain } = applyProgression(life, day, playerWon, r.challenge === true);
    r.repGain = repGain;
    r.prizeMoneyGain = prizeGain;
    const head = playerWon ? `WIN vs ${r.opp.name}` : `LOSS vs ${r.opp.name}`;
    const prize = playerWon ? ` · +$${prizeGain}` : '';
    r.result = `${head} · ${timeStr} · +${repGain} rep${prize}`;
    // H1079 (BL-3): a blacklist challenge win takes the rival's spot.
    const rival = r.blRank != null
      ? BLACKLIST_RIVALS.find((rv) => rv.rank === r.blRank) : undefined;
    if (rival && playerWon) {
      const bl = ensureBlacklistState(life);
      if (!bl.defeated.includes(rival.rank)) {
        bl.defeated.push(rival.rank);
        pushPage(life, {
          day, slot: life.timeSlot ?? 'night', type: 'blacklist',
          text: `#${rival.rank} ${rival.alias} IS DOWN. LADDER MOVES.`,
          read: false, expiresDay: day + 2,
        });
      }
      r.result = `#${rival.rank} ${rival.alias} DEFEATED · ${r.result}`;
    } else if (rival) {
      r.result = `#${rival.rank} ${rival.alias} KEEPS THE SPOT · ${r.result}`;
    }
  } else {
    r.winner = null;
    r.repGain = 0;
    r.result = r.spec.kind === 'drag' ? `ET ${timeStr}` : `${r.lap} laps · ${timeStr}`;
  }
  r.phase = 'done';
}

/** Enter the countdown: spawn the rival STAGED so it's visible before GO, and
 *  snapshot the staging position for jump-start detection. */
function enterCountdown(r: TrackRaceRun, spec: TrackRaceSpec, playerPx: number, playerPy: number, life: LifeState | null): void {
  r.phase = 'countdown';
  r.countdown = COUNTDOWN_S;
  r.result = null;
  r.winner = null;
  r.repGain = 0;
  r.leftStart = false;
  r.stageX = playerPx;
  r.stageY = playerPy;
  r.opp = spawnOpponent(spec, playerPy, life);
}

export function tickTrackRace(
  playerPx: number,
  playerPy: number,
  playerSpeed: number,
  ebrake: boolean,
  life: LifeState | null,
  day: number,
  dt: number,
  blocked: boolean,
): void {
  const mapId = getActiveMapId();
  const spec = getMapDef(mapId).race;
  if (!spec) { run = null; return; }
  if (blocked || dt <= 0) return;

  if (!run || run.mapId !== mapId) {
    run = {
      mapId, spec, phase: 'idle', countdown: 0, elapsed: 0,
      startX: 0, startY: 0, lap: 0, lapStart: 0, bestLap: null,
      leftStart: false, result: null, opp: null, winner: null, repGain: 0,
      prizeMoneyGain: 0, racedToday: false,
      stageX: 0, stageY: 0, warning: null, warnTimer: 0,
    };
  }
  if (run.warnTimer > 0) run.warnTimer = Math.max(0, run.warnTimer - dt);
  // H1029: one race per day — set from the shared lastRaceDay stamp.
  run.racedToday = !!life && life.lastRaceDay === day;

  const sx = (spec.startTile[0] + 0.5) * TILE;
  const sy = (spec.startTile[1] + 0.5) * TILE;
  const dToStart = Math.hypot(playerPx - sx, playerPy - sy);
  const inStart = dToStart <= spec.startRadius * TILE;
  const speed = Math.abs(playerSpeed);

  switch (run.phase) {
    case 'idle':
      // H1029: one race per day — don't arm if the player already raced today.
      // H1034: autoStage:false maps (the car meet) never auto-arm at the line —
      // they race by CHALLENGING a specific parked car (startMeetChallenge).
      if (spec.autoStage !== false && inStart && speed < STAGE_SPEED && !run.racedToday) {
        enterCountdown(run, spec, playerPx, playerPy, life);
      }
      break;

    case 'countdown': {
      if (!inStart) { run.phase = 'idle'; run.opp = null; break; }
      // H1020: JUMP START — leaving the line before GO restarts the count with
      // a warning. Holding the e-brake (revving at the line) is a legit launch
      // hold, so it's exempt.
      const crept = Math.hypot(playerPx - run.stageX, playerPy - run.stageY);
      if (!ebrake && crept > FALSE_START_TOL) {
        run.warning = '⚠ JUMP START';
        run.warnTimer = 1.6;
        run.countdown = COUNTDOWN_S;
        run.stageX = playerPx;   // re-baseline so the fresh count isn't stuck
        run.stageY = playerPy;
        break;
      }
      // The staged rival idles here (it appears before GO). Blip its revs so
      // the RPM sim is warm off the line.
      if (run.opp) run.opp.phys.rpm = 2600 + 1400 * Math.abs(Math.sin(run.countdown * 6));
      run.countdown -= dt;
      if (run.countdown <= 0) {
        run.phase = 'running';
        run.elapsed = 0;
        run.lap = 0;
        run.lapStart = 0;
        run.bestLap = null;
        run.leftStart = false;
        run.startX = playerPx;
        run.startY = playerPy;
        if (run.opp) run.opp.phys.rpm = 900;
      }
      break;
    }

    case 'running': {
      run.elapsed += dt;
      if (run.opp && !run.opp.finished) advanceOpp(run.opp, spec, run.startY, dt);

      let playerFinished = false;
      if (spec.kind === 'drag') {
        const traveled = Math.hypot(playerPx - run.startX, playerPy - run.startY);
        if (traveled >= (spec.meters ?? 402) * WPX_PER_M) playerFinished = true;
      } else {
        if (!run.leftStart && dToStart > spec.startRadius * TILE * 2.2) run.leftStart = true;
        if (run.leftStart && inStart) {
          const lapTime = run.elapsed - run.lapStart;
          run.lap += 1;
          if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
          run.lapStart = run.elapsed;
          run.leftStart = false;
          if (run.lap >= (spec.laps ?? 3)) playerFinished = true;
        }
      }

      const oppFinished = run.opp?.finished ?? false;
      if (playerFinished || oppFinished) finishRun(run, life, day, playerFinished);
      break;
    }

    case 'done':
      if (!inStart) { run.leftStart = true; }
      // H1029: re-arm on return only if the daily race hasn't been used.
      // H1034: autoStage:false (meet) never re-arms — the result banner's
      // buttons return to the meet / city instead.
      else if (spec.autoStage !== false && run.leftStart && speed < STAGE_SPEED && !run.racedToday) {
        enterCountdown(run, spec, playerPx, playerPy, life);
      }
      break;
  }

  // H1029: re-stamp after the state machine so a finish this frame (which sets
  // life.lastRaceDay) is reflected on the result screen immediately — no
  // one-frame RACE AGAIN flicker before the daily limit reads as used.
  run.racedToday = !!life && life.lastRaceDay === day;
}
