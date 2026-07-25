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
import { RENDER_ENTRIES } from '@/render/worldMap';
import {
  buildTrackPath, advanceTrackAI, cornerSpeedCap, poseAt, nearestS,
  type TrackPath, type TrackAiState,
} from '@/sim/trackAI';
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
  /** H1244: circuit cursor — set only for path-following opponents on a real
   *  circuit. drag/oval rivals steer by their own hard-coded rules and leave
   *  this undefined. */
  ai?: TrackAiState;
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
  /** H1086 (solo): the most recently completed lap time (null until one done). */
  lastLap: number | null;
  leftStart: boolean;
  result: string | null;
  /** H1244: the opponent FIELD. Was a single `opp` through H1243 — a drag or
   *  oval race still puts exactly one car in here, but a circuit runs a full
   *  grid, so every consumer reads the array. */
  opps: TrackRaceOpp[];
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
  /** H1088: the run ended by going OVER THE EDGE (touge canyon fall) rather
   *  than reaching the finish — the result banner reads as a wipeout. */
  failed?: boolean;
  /** H1094: live race rank vs the opponent (1 = leading, 2 = trailing),
   *  recomputed each running frame from actual track progress (drag metres /
   *  oval angle) — not the coarse lap count. Only set while a 1v1 run.opp
   *  exists; undefined otherwise. */
  position?: number;
  /** H1094: player's cumulative ellipse angle (oval position), unwrapped so it
   *  grows monotonically per lap to match the opponent's o.theta. */
  pAngle?: number;
  /** H1094: last raw atan2 sample for the unwrap (NaN until the first frame). */
  pAnglePrev?: number;
  /** H1245: this circuit session is an ARMED GRID RACE (formed by rolling into
   *  the start zone), not free practice. Practice never ends and never spawns a
   *  field; a grid race runs the spec's lap count and pays out by position. */
  gridRace?: boolean;
}

let run: TrackRaceRun | null = null;

/** m:ss.ss (or ss.ss under a minute) for the sprint result banner. */
function fmtSprint(s: number): string {
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem.toFixed(2)}`;
}

const STAGE_SPEED = 45;      // near-stopped to arm (wpx/s)
const COUNTDOWN_S = 3;
const FALSE_START_TOL = 1.2 * TILE;  // leaving the line before GO = jump start
const LANE_HALF = 0.64;       // half a lane in tiles (racers stage one per lane)
const OVAL_LANE_TILES = 1.3;  // opponent runs one lane inside the player's line

/** Oval opponent cornering cap (fraction of its top speed) so a tight loop is
 *  beatable — the AI follows the ellipse on rails, so without this it would
 *  corner at top speed. Tunable. */
const OVAL_SPEED_FRAC = 0.6;

// ---------------------------------------------------------------------------
// H1244: CIRCUIT FIELD — AI cars that actually lap a real circuit.
//
// The four real circuits run spec.solo (a free best-lap timer, no countdown, no
// daily cap). That branch is left intact; this adds a field of path-following
// rivals on top of it, so a lap session now has traffic to race. The timer, the
// uncapped re-lapping and the never-"done" behaviour are all unchanged.
// ---------------------------------------------------------------------------

/** How many AI cars join a circuit session. The user asked for up to 8 total
 *  (7 AI); this is the default until the pit RACE SETUP panel exposes it. */
const CIRCUIT_FIELD = 5;
/** Gap between grid slots, in metres of track. */
const CIRCUIT_GRID_GAP_M = 45;
/** Lateral spread from the centerline, in tiles. */
const CIRCUIT_LANE_TILES = 1.15;

/** Cached path per map — rebuilt when the map changes (RENDER_ENTRIES is
 *  replaced wholesale by rebuildRenderEntries). */
let _pathMapId: string | null = null;
let _path: TrackPath | null = null;

function circuitPath(mapId: string): TrackPath | null {
  if (_pathMapId === mapId && _path) return _path;
  // On a circuit map the entry list is the track: take the longest polyline.
  let bestPts: number[] | null = null;
  for (const e of RENDER_ENTRIES) {
    const pts = e.smoothed;
    if (!pts || pts.length < 6) continue;
    if (!bestPts || pts.length > bestPts.length) bestPts = pts as number[];
  }
  _pathMapId = mapId;
  _path = bestPts ? buildTrackPath(bestPts, TILE) : null;
  return _path;
}

/** Build the AI field for a circuit, ALTERNATING behind and ahead of the
 *  player.
 *
 *  Spawning the whole field ahead was the first attempt and it failed the
 *  smoke test: the AI accelerates away immediately while the player is still
 *  sitting at the line, so by the time anyone looked they were 86 m up the road
 *  and off screen — a field of five cars that the player never saw. Cars
 *  BEHIND close on a stationary player within seconds and stream past, which is
 *  also what arriving mid-session should feel like. */
function spawnCircuitField(
  path: TrackPath,
  playerPx: number,
  playerPy: number,
  life: LifeState | null,
  count: number,
): TrackRaceOpp[] {
  const out: TrackRaceOpp[] = [];
  const used = new Set<string>();
  const baseS = nearestS(path, playerPx, playerPy);
  for (let i = 0; i < count; i++) {
    // generateRaceOpponent can repeat ids and can return null when the tier
    // filter empties — dedupe, and take what we can get rather than assuming
    // the field fills.
    let id: string | null = null;
    for (let tries = 0; tries < 8 && !id; tries++) {
      const cand = generateRaceOpponent(playerCarIdOf(life));
      if (cand && !used.has(cand)) id = cand;
    }
    if (!id) continue;
    used.add(id);
    const car = CAR_CATALOG[id];
    if (!car) continue;
    // -1, +1, -2, +2, ... slots away from the player.
    const slot = (Math.floor(i / 2) + 1) * (i % 2 === 0 ? -1 : 1);
    const ai: TrackAiState = {
      s: baseS + slot * CIRCUIT_GRID_GAP_M * WPX_PER_M,
      lane: (i % 2 === 0 ? 1 : -1) * CIRCUIT_LANE_TILES * TILE * (0.5 + 0.5 * ((i >> 1) % 2)),
      // Spread the pace so the field strings out instead of running as a train.
      skill: 0.90 + 0.13 * ((i * 37 % 11) / 10),
      lap: 0,
    };
    const pose = poseAt(path, ai.s, ai.lane);
    // ROLLING start: a session already in progress, not five cars launching
    // from rest next to you. Seeded at the pace this bit of track allows.
    const seed = Math.min(car.topSpeed * 0.55, cornerSpeedCap(path, ai.s, ai.skill));
    out.push({
      id, name: car.name,
      x: pose.x, y: pose.y, angle: pose.angle,
      phys: { speed: isFinite(seed) ? seed : car.topSpeed * 0.55, rpm: 3200, gear: 3, shiftTimer: 0 },
      topSpeed: car.topSpeed,
      dist: 0, theta: 0, lap: 0, finished: false,
      ai,
    });
  }
  return out;
}

/** Standard lane width in tiles (render/roads/crossingGeom LANE_W_STD). A
 *  circuit is w=6 → 4 lanes, so lane centres sit at ±0.64 and ±1.91 tiles. */
const LANE_W_STD_T = 1.275;
/** Longitudinal gap between grid ROWS, in tiles. */
const GRID_ROW_TILES = 5.5;

/** H1245: stationary STARTING GRID — every car in its own lane.
 *
 *  The user's report was that racers shared a lane (and on the drag strip the
 *  player straddled the centreline). A circuit is four lanes wide, so this
 *  lays the field out two-abreast in the inner and outer lane pairs, one row
 *  behind another, with the player on pole. Cars are placed BEHIND the start
 *  line and are NOT moving — the countdown holds them there. */
function spawnCircuitGrid(
  path: TrackPath,
  playerPx: number,
  playerPy: number,
  life: LifeState | null,
  count: number,
): TrackRaceOpp[] {
  const out: TrackRaceOpp[] = [];
  const used = new Set<string>();
  const baseS = nearestS(path, playerPx, playerPy);
  // Two columns, offset either side of the centreline by ~0.95 tiles — that is
  // 34 wpx apart, a full car width, and comfortably inside the 5.1-tile
  // surface. Every car therefore has its own lane, which was the report.
  const lanes = [-0.75 * LANE_W_STD_T, 0.75 * LANE_W_STD_T];
  for (let i = 0; i < count; i++) {
    let id: string | null = null;
    for (let tries = 0; tries < 8 && !id; tries++) {
      const cand = generateRaceOpponent(playerCarIdOf(life));
      if (cand && !used.has(cand)) id = cand;
    }
    if (!id) continue;
    used.add(id);
    const car = CAR_CATALOG[id];
    if (!car) continue;
    // The player holds POLE where they stopped, so every rival starts at least
    // one row BEHIND. Placing a rival alongside pole put it 0.64 tiles away —
    // less than a car width, i.e. spawned overlapping the player.
    const row = Math.floor(i / 2) + 1;
    const ai: TrackAiState = {
      s: baseS - row * GRID_ROW_TILES * TILE,
      lane: lanes[i % 2] * TILE,
      skill: 0.90 + 0.13 * ((i * 37 % 11) / 10),
      lap: 0,
    };
    const pose = poseAt(path, ai.s, ai.lane);
    out.push({
      id, name: car.name,
      x: pose.x, y: pose.y, angle: pose.angle,
      // STATIONARY on the grid — the countdown releases them.
      phys: { speed: 0, rpm: 900, gear: 1, shiftTimer: 0 },
      topSpeed: car.topSpeed,
      dist: 0, theta: 0, lap: 0, finished: false,
      ai,
    });
  }
  return out;
}

/** Close out a grid race: rank the player against the field and pay out. */
function finishGridRace(r: TrackRaceRun, life: LifeState | null, day: number): void {
  const pos = r.position ?? 1;
  const field = r.opps.length + 1;
  r.phase = 'done';
  r.winner = pos === 1 ? 'player' : 'opponent';
  const timeStr = `${r.elapsed.toFixed(2)}s · best ${(r.bestLap ?? r.elapsed).toFixed(2)}s`;
  if (life) {
    // Position-scaled: a podium in a big field still pays.
    const won = pos === 1;
    const { repGain, prizeGain } = applyProgression(life, day, won, true);
    // Taper the prize down the order rather than paying only the winner.
    const scaled = Math.round(prizeGain * Math.max(0, 1 - (pos - 1) / field));
    if (!won && scaled > 0) life.money = (life.money ?? 0) + scaled;
    r.repGain = repGain;
    r.prizeMoneyGain = won ? prizeGain : scaled;
    r.result = `P${pos} of ${field} · ${timeStr} · +${repGain} rep`
      + (r.prizeMoneyGain > 0 ? ` · +$${r.prizeMoneyGain}` : '');
  } else {
    r.result = `P${pos} of ${field} · ${timeStr}`;
  }
}

/** Signed gap (metres of track) from the player to a rival, wrapped onto the
 *  closed lap so half a lap ahead reads as half a lap BEHIND. Positive = the
 *  rival is up the road. */
function lapGapM(path: TrackPath, oppS: number, playerS: number): number {
  const half = path.total / 2;
  let d = (oppS - playerS) % path.total;
  if (d > half) d -= path.total;
  if (d < -half) d += path.total;
  return d / WPX_PER_M;
}

/** How far up/down the road the field is allowed to drift before the pace
 *  adjusts, and the hardest it will push either way. */
const BAND_FREE_M = 120;
const BAND_SPAN_M = 700;
const BAND_MIN = 0.66;
const BAND_MAX = 1.18;

/** Advance one circuit rival: real longitudinal physics, capped by the corner
 *  the AI can see coming, then walked along the centerline.
 *
 *  `playerS` drives a pace band. Without it the field simply drives away — the
 *  smoke test had five cars 86 m up the road and off screen while the player
 *  was still parked at the line, i.e. a field the player never actually sees.
 *  Rivals more than BAND_FREE_M ahead ease off and rivals that far behind push
 *  on, so the session stays a race instead of a procession. Clamped hard at
 *  both ends: they never stop, and they never teleport up to you. */
function advanceCircuitOpp(o: TrackRaceOpp, path: TrackPath, playerS: number, dt: number): void {
  const car = CAR_CATALOG[o.id];
  if (!car || !o.ai) return;
  advanceOppPhysics(o.phys, car, dt);
  // Straight-line pace also scales with skill, so a good driver isn't just
  // better in corners.
  const straightCap = o.topSpeed * (0.82 + 0.18 * o.ai.skill);
  let cap = Math.min(straightCap, cornerSpeedCap(path, o.ai.s, o.ai.skill));
  const gap = lapGapM(path, o.ai.s, playerS);
  const over = Math.abs(gap) - BAND_FREE_M;
  if (over > 0) {
    const pull = Math.min(1, over / BAND_SPAN_M);
    const f = gap > 0
      ? 1 - (1 - BAND_MIN) * pull   // ahead: back off
      : 1 + (BAND_MAX - 1) * pull;  // behind: press on
    cap *= f;
  }
  if (o.phys.speed > cap) o.phys.speed = cap;
  const pose = advanceTrackAI(o.ai, path, o.phys.speed, dt);
  o.x = pose.x; o.y = pose.y; o.angle = pose.angle;
  o.lap = o.ai.lap;
}

export function getTrackRaceRun(): TrackRaceRun | null {
  return run;
}
export function resetTrackRace(): void {
  run = null;
  _pathMapId = null;
  _path = null;
}

/** H1088: end the active run as a WIPEOUT — the player went off the edge on a
 *  touge. Freezes it into the 'done' banner (red, RETRY / RETURN buttons) with
 *  no time/best recorded. No-op when there's no run (free-roam off a fatal map
 *  with no sprint spec). */
export function failTougeRun(): void {
  if (!run) return;
  run.phase = 'done';
  run.failed = true;
  run.winner = 'opponent';   // red banner via the done-branch coloring
  run.result = '💀 OVER THE EDGE · RUN OVER';
  run.opps = [];
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
    startX: 0, startY: 0, lap: 0, lapStart: 0, bestLap: null, lastLap: null, leftStart: false,
    result: null, opps: [], winner: null, repGain: 0, prizeMoneyGain: 0,
    racedToday: false, stageX: playerPx, stageY: playerPy, warning: null, warnTimer: 0,
    challenge: true, blRank,
  };
  run.opps = [{
    id: opponentId, name: car.name,
    x: (spec.startTile[0] + LANE_HALF) * TILE, y: playerPy, angle: Math.PI / 2,
    phys: { speed: 0, rpm: 900, gear: 1, shiftTimer: 0 },
    topSpeed: car.topSpeed, dist: 0, theta: 0, lap: 0, finished: false,
  }];
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

/** H1094: fold the player's raw ellipse angle (atan2, wraps at ±π) into a
 *  cumulative angle that grows monotonically as they lap — the same measure the
 *  opponent's o.theta already is, so the two are directly comparable for the
 *  live position. `prev` is the last raw sample (NaN on the first frame).
 *  Returns the updated { cumulative, prev }. */
function unwrapAngle(rawTh: number, cumulative: number, prev: number): { cum: number; prev: number } {
  if (Number.isNaN(prev)) return { cum: cumulative, prev: rawTh };
  let d = rawTh - prev;
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return { cum: cumulative + d, prev: rawTh };
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
  const lead = r.opps[0];
  if (lead && life) {
    r.winner = playerWon ? 'player' : 'opponent';
    const { repGain, prizeGain } = applyProgression(life, day, playerWon, r.challenge === true);
    r.repGain = repGain;
    r.prizeMoneyGain = prizeGain;
    const head = playerWon ? `WIN vs ${lead.name}` : `LOSS vs ${lead.name}`;
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
  const one = spawnOpponent(spec, playerPy, life);
  r.opps = one ? [one] : [];
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
      startX: 0, startY: 0, lap: 0, lapStart: 0, bestLap: null, lastLap: null,
      leftStart: false, result: null, opps: [], winner: null, repGain: 0,
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

  // H1086: SOLO best-lap timer (the real circuits). No opponent, no countdown,
  // no daily cap, never "done": the clock runs continuously from spawn and each
  // start-line re-cross (after leaving the zone — the same 2.2x hysteresis the
  // opponent lap uses) records a lap and updates the best. Pure handling test.
  if (spec.solo) {
    const path = circuitPath(mapId);

    // H1245: the circuit session is now PRACTICE until you line up.
    //
    // H1244 spawned the field the instant you arrived, which — with the player
    // then spawning on the racing line — meant the AI drove over a stationary
    // car before the player had touched anything, and there was no countdown
    // because this branch never ran one. So: arrive to an EMPTY track, lap it
    // freely, and roll into the start/finish zone slowly to form a grid.
    if (run.phase === 'idle' || run.phase === 'countdown' || run.phase === 'running') {
      // (fall through — handled below)
    }

    // --- arm: roll into the start zone slowly, on track, out of the pits ---
    if (run.phase !== 'countdown' && !run.gridRace && inStart && speed < STAGE_SPEED && path) {
      run.phase = 'countdown';
      run.countdown = COUNTDOWN_S;
      run.gridRace = true;
      run.result = null;
      run.winner = null;
      run.stageX = playerPx; run.stageY = playerPy;
      run.lap = 0; run.lapStart = 0; run.elapsed = 0;
      run.bestLap = null; run.lastLap = null; run.leftStart = false;
      run.opps = spawnCircuitGrid(path, playerPx, playerPy, life, CIRCUIT_FIELD);
      return;
    }

    if (run.phase === 'countdown') {
      // Rivals hold station on the grid, blipping the throttle.
      for (const o of run.opps) o.phys.rpm = 2600 + 1400 * Math.abs(Math.sin(run.countdown * 6));
      run.countdown -= dt;
      if (run.countdown <= 0) {
        run.phase = 'running';
        run.elapsed = 0; run.lap = 0; run.lapStart = 0; run.leftStart = false;
        run.startX = playerPx; run.startY = playerPy;
        for (const o of run.opps) o.phys.rpm = 900;
      }
      return;
    }

    if (run.phase !== 'running') {
      run.phase = 'running';
      run.elapsed = 0; run.lap = 0; run.lapStart = 0;
      run.bestLap = null; run.lastLap = null; run.leftStart = false;
      run.startX = playerPx; run.startY = playerPy;
      run.opps = [];          // practice starts on an empty track
    }
    run.elapsed += dt;
    if (path) {
      const pS = nearestS(path, playerPx, playerPy);
      for (const o of run.opps) advanceCircuitOpp(o, path, pS, dt);
      // Rank on TOTAL distance covered (laps + position on this lap), so a
      // rival a lap down isn't credited with leading just because it happens to
      // be further round the current lap.
      const pTotal = pS + run.lap * path.total;
      run.position = 1 + run.opps.filter((o) => (o.ai ? o.ai.s : 0) > pTotal).length;
    }
    if (!run.leftStart && dToStart > spec.startRadius * TILE * 2.2) run.leftStart = true;
    if (run.leftStart && inStart) {
      const lapTime = run.elapsed - run.lapStart;
      run.lap += 1;
      run.lastLap = lapTime;
      if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
      run.lapStart = run.elapsed;
      run.leftStart = false;
      // A grid race is over the spec's lap count; practice never ends.
      if (run.gridRace && run.lap >= (spec.laps ?? 3)) {
        finishGridRace(run, life, day);
      }
    }
    return;
  }

  // H1087: SPRINT point-to-point timer (touge). idle (staged at the summit) ->
  // running (the moment you leave the start line) -> done (reaching the base
  // finish zone). No opponent, no countdown, no daily cap. best-time persists
  // across drive-back-up re-arms (until the map is switched / re-entered).
  if (spec.kind === 'sprint') {
    const fx = ((spec.finishTile?.[0] ?? spec.startTile[0]) + 0.5) * TILE;
    const fy = ((spec.finishTile?.[1] ?? spec.startTile[1]) + 0.5) * TILE;
    const inFinish = Math.hypot(playerPx - fx, playerPy - fy) <= (spec.finishRadius ?? 6) * TILE;
    if (run.phase === 'done') {
      // Returning to the summit re-arms a fresh run — but a WIPEOUT (canyon
      // fall) holds the banner until the player hits RETRY / RETURN (the car is
      // frozen mid-fall, so an off-edge near the start must not silently re-arm).
      if (inStart && !run.failed) { run.phase = 'idle'; run.elapsed = 0; run.result = null; run.winner = null; }
    } else if (run.phase === 'running') {
      run.elapsed += dt;
      if (inFinish) {
        const t = run.elapsed;
        run.lastLap = t;
        const isBest = run.bestLap === null || t < run.bestLap;
        if (isBest) run.bestLap = t;
        run.phase = 'done';
        run.winner = isBest ? 'player' : null;
        run.result = `FINISH · ${fmtSprint(t)}`
          + (run.bestLap != null ? ` · best ${fmtSprint(run.bestLap)}` : '');
      }
    } else {
      // idle: staged at the summit; hold the clock at 0 until the player
      // leaves the start line (drives down out of the start zone).
      run.elapsed = 0;
      if (!inStart) { run.phase = 'running'; run.startX = playerPx; run.startY = playerPy; }
    }
    return;
  }

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
      if (!inStart) { run.phase = 'idle'; run.opps = []; break; }
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
      for (const o of run.opps) o.phys.rpm = 2600 + 1400 * Math.abs(Math.sin(run.countdown * 6));
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
        run.pAngle = 0;          // H1094: reset the oval-position unwrap
        run.pAnglePrev = NaN;
        for (const o of run.opps) o.phys.rpm = 900;
      }
      break;
    }

    case 'running': {
      run.elapsed += dt;
      for (const o of run.opps) if (!o.finished) advanceOpp(o, spec, run.startY, dt);

      // H1094: live rank from real track progress (not lap count — a drag stays
      // on lap 0, so the old compare always read P1). drag = metres from the
      // line vs opp.dist; oval = the player's unwrapped cumulative angle vs the
      // opponent's o.theta.
      if (run.opps.length) {
        let pProg: number;
        const oProg = (o: TrackRaceOpp): number => {
          if (spec.kind === 'drag') return o.dist;
          if (spec.ovalCenter) return o.theta;
          return o.lap;
        };
        if (spec.kind === 'drag') {
          pProg = Math.hypot(playerPx - run.startX, playerPy - run.startY);
        } else if (spec.ovalCenter) {
          const cx = spec.ovalCenter[0] * TILE, cy = spec.ovalCenter[1] * TILE;
          const rx = (spec.ovalRx ?? 60) * TILE, ry = (spec.ovalRy ?? 40) * TILE;
          const rawTh = Math.atan2((playerPy - cy) / ry, (playerPx - cx) / rx);
          const u = unwrapAngle(rawTh, run.pAngle ?? 0, run.pAnglePrev ?? NaN);
          run.pAngle = u.cum; run.pAnglePrev = u.prev;
          pProg = run.pAngle;
        } else {
          pProg = run.lap;
        }
        // Rank = one plus however many rivals are ahead. With a single rival
        // this is exactly the old 1-or-2.
        run.position = 1 + run.opps.filter((o) => oProg(o) > pProg).length;
      }

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

      const oppFinished = run.opps.some((o) => o.finished);
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
