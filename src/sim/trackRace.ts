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
import { startLineOn, trackPathFor } from '@/world/startLine';
import { gridSlot } from '@/config/world/startGrid';
import {
  advanceTrackAI, cornerSpeedCap, poseAt, nearestS,
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
  /** H1247: a QUALIFYING run — one flying lap against the clock, no field. */
  qualifying?: boolean;
  /** H1269: the flying lap has not started yet — a qualifying session's first
   *  line crossing is the OUT lap and is not timed. */
  outLap?: boolean;
  /** H1269 lap cursor. `pSWrap` is last frame's wrapped arc position, `pTotal`
   *  the UNWRAPPED one (it decreases when you reverse — that is what makes
   *  driving back over the line un-earn itself), and `lapMark` the pTotal at
   *  the last credited line crossing. All undefined until the first running
   *  frame; see tickLapCursor. */
  pSWrap?: number;
  pTotal?: number;
  lapMark?: number;
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

/** Cached path per map — RENDER_ENTRIES is rebuilt in place on a map switch,
 *  and switchMap calls resetTrackRace right after, which drops this. */
let _pathMapId: string | null = null;
let _path: TrackPath | null = null;

/** H1267: this now goes through world/startLine.trackPathFor, the SAME resolver
 *  render/startGrid paints from. It used to pick the longest polyline in
 *  RENDER_ENTRIES independently; keeping two resolvers meant the grid could be
 *  painted on one interpretation of "the track" and the cars posed on another. */
function circuitPath(mapId: string): TrackPath | null {
  if (_pathMapId === mapId && _path) return _path;
  _pathMapId = mapId;
  _path = trackPathFor(getMapDef(mapId));
  _lineS = null;
  return _path;
}

/** H1269: arc length of the painted start/finish line, cached per map.
 *
 *  startLineOn projects the staging tile onto the centerline and samples the
 *  spawn heading — two O(vertices) scans over a 1300-point path. That is fine
 *  once and absurd sixty times a second, which is what calling it from the
 *  per-frame lap check would have done. */
let _lineS: number | null = null;
function startLineArc(mapId: string, path: TrackPath, spec: TrackRaceSpec): number {
  if (_lineS === null) _lineS = startLineOn(path, getMapDef(mapId), spec).s;
  return _lineS;
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

/** H1245: stationary STARTING GRID — every car in its own lane.
 *
 *  The user's report was that racers shared a lane (and on the drag strip the
 *  player straddled the centreline). A circuit is four lanes wide, so this
 *  lays the field out in two staggered columns, with the player on pole. Cars
 *  are placed BEHIND the start line and are NOT moving — the countdown holds
 *  them there.
 *
 *  H1267: the grid is anchored on the PAINTED start/finish line (`sLine`) and
 *  laid out from the shared config/world/startGrid slot table, so every car
 *  parks inside a painted box. It used to anchor on wherever the player
 *  happened to stop, which — now that there are boxes on the ground — would
 *  have put the whole field beside them instead of in them. */
function spawnCircuitGrid(
  path: TrackPath,
  sLine: number,
  fwd: number,
  life: LifeState | null,
  count: number,
): TrackRaceOpp[] {
  const out: TrackRaceOpp[] = [];
  const used = new Set<string>();
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
    // Rival i takes painted slot i+1 — slot 0 is POLE, which the player holds.
    // Slots alternate sides and step back by half a row pitch each time, so no
    // two cars share a lane and none is closer than a car width to another.
    const slot = gridSlot(i + 1);
    const ai: TrackAiState = {
      s: sLine - fwd * slot.backT * TILE,
      lane: fwd * slot.laneT * TILE,
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

/** H1269: close out a QUALIFYING run — one flying lap, no field, no payout.
 *  It sets a time and nothing else, so it never touches the daily race cap. */
function finishQualifying(r: TrackRaceRun): void {
  r.phase = 'done';
  r.winner = null;
  r.qualifying = false;
  r.opps = [];
  r.result = `QUALIFYING · ${fmtSprint(r.lastLap ?? r.elapsed)}`;
}

/** Close out a grid race: rank the player against the field and pay out. */
function finishGridRace(r: TrackRaceRun, life: LifeState | null, day: number): void {
  // H1269: `?? 1` here used to hand the player an unearned FIRST PLACE and the
  // full prize whenever position was unset — which it is on any frame the
  // cursor could not be established. Worst case last, not best case first.
  const pos = r.position ?? (r.opps.length + 1);
  // H1269: the session is over. Leaving this set kept the arm gate blocked AND
  // let the old one-frame-reset bug re-enter the race with the lap count back
  // at zero, re-paying rep and prize money indefinitely.
  r.gridRace = false;
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

// ---------------------------------------------------------------------------
// H1269: LAP INTEGRITY.
//
// The old gate was a distance-to-a-circle hysteresis with NO direction term:
// leave a 198 wpx circle, come back inside a 90 wpx one, +1 lap. So a ~34 m
// shuffle back and forth across the start/finish straight scored a lap —
// exactly what the user reported — and on a grid race that re-paid rep and
// prize money every three shuffles.
//
// This replaces it with an arc-length CURSOR on the same TrackPath the AI and
// the painted start line already use. A lap needs BOTH:
//
//   1. a FORWARD crossing of the painted start/finish line, and
//   2. at least ~a full lap of forward travel since the last credited crossing.
//
// (2) is what makes it exploit-proof, and it is exact rather than heuristic:
// the cursor advances by the projection onto the CENTERLINE, so going round
// once always advances it by path.total no matter what racing line is driven.
// Shuffling over the line travels ~0 and is refused. Cutting the infield
// crosses the line having travelled half a lap and is refused. Reversing over
// the line decrements the crossing count and then has to earn the distance
// back, so the exploit does not simply move.
// ---------------------------------------------------------------------------

/** Fraction of a lap that must be travelled forward before a line crossing
 *  counts. Not 1.0 because the teleport guard below can legitimately drop a
 *  few frames' worth of cursor travel on a hitch, and the failure direction we
 *  want is "this lap took slightly longer", never "free lap". */
const LAP_MIN_FRAC = 0.9;
/** Search window (world px) around last frame's cursor. A global nearest-point
 *  scan can snap to a PARALLEL part of the lap — Laguna's branches pass within
 *  375 wpx of each other — which would teleport the cursor across the track.
 *  300 wpx is ~20x the worst realistic one-frame step (250 km/h at 30 fps is
 *  ~15 wpx) and comfortably inside that separation. */
const LAP_WINDOW_PX = 300;
/** Floor for the per-frame jump guard (world px). */
const LAP_MIN_STEP_PX = 48;

/** Arc length of the point nearest (x,y), searched only within ±`window` of
 *  `prevS` along the path. Falls back to a global scan when there is no
 *  previous cursor (NaN) or the window turns up nothing. */
function nearestSWindowed(
  path: TrackPath, x: number, y: number, prevS: number, window: number,
): number {
  if (!isFinite(prevS)) return nearestS(path, x, y);
  const m = path.cum.length;
  const half = path.total / 2;
  const centre = path.closed ? ((prevS % path.total) + path.total) % path.total : prevS;
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < m; i++) {
    let dS = path.cum[i] - centre;
    if (path.closed) {
      if (dS > half) dS -= path.total;
      if (dS < -half) dS += path.total;
    }
    if (Math.abs(dS) > window) continue;
    const d = (path.pts[i * 2] - x) ** 2 + (path.pts[i * 2 + 1] - y) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best < 0 ? nearestS(path, x, y) : path.cum[best];
}

/**
 * Advance the player's lap cursor one frame. Returns true iff a lap was
 * completed on THIS frame.
 *
 * `lineS` is the arc length of the painted start/finish line (world/startLine),
 * so the lap ticks over exactly where the checker is drawn — not at the path's
 * arbitrary vertex 0, and not at wherever the player happened to stop to arm.
 */
function tickLapCursor(
  r: TrackRaceRun, path: TrackPath, lineS: number, px: number, py: number,
  speed: number, dt: number,
): boolean {
  const s = nearestSWindowed(path, px, py, r.pSWrap ?? NaN, LAP_WINDOW_PX);
  if (r.pSWrap === undefined || r.pTotal === undefined) {
    // First frame of the session: seed, credit nothing.
    r.pSWrap = s;
    r.pTotal = s;
    r.lapMark = s;
    return false;
  }
  const half = path.total / 2;
  let d = s - r.pSWrap;
  if (d > half) d -= path.total;
  if (d < -half) d += path.total;
  r.pSWrap = s;
  // Respawns, garage exits and off-track cursor snaps all present as an
  // impossible one-frame jump. Resync and award nothing — losing a little
  // credited distance is the safe direction.
  const maxStep = Math.max(LAP_MIN_STEP_PX, Math.abs(speed) * dt * 3 + 24);
  if (Math.abs(d) > maxStep) return false;
  const before = r.pTotal;
  const after = before + d;
  r.pTotal = after;
  // Forward line crossing = the floor of (position relative to the line)
  // stepping up. Going backwards steps it down and credits nothing.
  const lapsAt = (v: number): number => Math.floor((v - lineS) / path.total);
  if (lapsAt(after) <= lapsAt(before)) return false;
  if (after - (r.lapMark ?? after) < path.total * LAP_MIN_FRAC) return false;
  r.lapMark = after;
  r.lap += 1;
  return true;
}

/** Clear the cursor so the next running frame re-seeds it. Must be called
 *  anywhere run.lap is reset, or the new session inherits the old progress. */
function resetLapCursor(r: TrackRaceRun): void {
  r.pSWrap = undefined;
  r.pTotal = undefined;
  r.lapMark = undefined;
}

/** H1269: exposed for tools/maplab/lapcheck.mjs. The lap predicate is the one
 *  piece of this file that can be exercised without a running game, and it is
 *  the piece a user-reported exploit lived in — so it gets a real test. */
export const _lapInternals = { tickLapCursor, resetLapCursor, nearestSWindowed };

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
  _lineS = null;
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

/**
 * H1267: world Y of the drag strip's FINISH LINE — the one render/startGrid
 * paints the checker on.
 *
 * Both drag venues are a dead-straight strip running +y (mapRegistry
 * dragStripRoads / carMeetRoads), so the line is simply the staging tile's
 * centre plus the run distance; on a straight the arc-length projection
 * render/startGrid uses lands on exactly the same Y.
 *
 * This replaces a RELATIVE test — `hypot(px - run.startX, py - run.startY) >=
 * meters * WPX_PER_M`, measured from wherever the player was standing at GO.
 * The staging zone is 5 tiles (14 m) across, so the old finish floated up to
 * 14 m either side of any fixed marking: at 200 km/h a quarter-second of
 * disagreement between the checker going past and the timer stopping.
 */
function dragFinishY(spec: TrackRaceSpec): number {
  return (spec.startTile[1] + 0.5) * TILE + (spec.meters ?? 402) * WPX_PER_M;
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
    // H1267: the finish is the PAINTED line — a fixed world Y — not a distance
    // travelled from wherever this car happened to stage. See dragFinishY.
    if (o.y >= dragFinishY(spec)) o.finished = true;
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

    // --- arm: stop on the start line with a session chosen in the pit menu ---
    //
    // H1247: this is now DELIBERATE. Rolling into the zone used to arm a grid
    // by itself; the user wants to pick Test Lap / Qualify / Start Race in the
    // pit, drive out, stop on the line, and confirm. life._trackMode carries
    // the choice; life._trackStartPrompt tells the HUD to offer the button.
    const mode = life?._trackMode ?? null;
    if (run.phase !== 'countdown' && !run.gridRace && inStart && speed < STAGE_SPEED && path && mode) {
      if (!life?._trackStartArm) {
        // Waiting on the player to confirm — the HUD paints the prompt.
        if (life) life._trackStartPrompt = mode;
        return;
      }
      if (life) { life._trackStartArm = false; life._trackStartPrompt = null; }
      run.result = null;
      run.winner = null;
      run.stageX = playerPx; run.stageY = playerPy;
      run.lap = 0; run.lapStart = 0; run.elapsed = 0;
      run.bestLap = null; run.lastLap = null; run.leftStart = false;
      if (mode === 'race') {
        run.phase = 'countdown';
        run.countdown = COUNTDOWN_S;
        run.gridRace = true;
        // H1267: grid up on the painted line, not on the player's stop point.
        const line = startLineOn(path, getMapDef(mapId), spec);
        run.opps = spawnCircuitGrid(path, line.s, line.fwd, life, CIRCUIT_FIELD);
      } else {
        // Test lap / qualifying are solo against the clock — no field.
        run.phase = 'running';
        run.opps = [];
        run.qualifying = mode === 'qualify';
        // H1269: qualifying is ONE FLYING LAP, so the lap out of the pits is
        // not it. The first line crossing ends the out lap and starts the
        // timed one.
        run.outLap = run.qualifying;
        run.startX = playerPx; run.startY = playerPy;
      }
      resetLapCursor(run);
      if (life) life._trackMode = null;
      return;
    }
    if (life && (!inStart || !mode)) life._trackStartPrompt = null;

    if (run.phase === 'countdown') {
      // Rivals hold station on the grid, blipping the throttle.
      for (const o of run.opps) o.phys.rpm = 2600 + 1400 * Math.abs(Math.sin(run.countdown * 6));
      run.countdown -= dt;
      if (run.countdown <= 0) {
        run.phase = 'running';
        run.elapsed = 0; run.lap = 0; run.lapStart = 0; run.leftStart = false;
        run.startX = playerPx; run.startY = playerPy;
        resetLapCursor(run);
        for (const o of run.opps) o.phys.rpm = 900;
      }
      return;
    }

    // H1269: A FINISHED SESSION HOLDS ITS BANNER.
    //
    // This was the "I did three laps at Monza and it didn't end" bug, and it was
    // nastier than a missing lap count: finishGridRace set phase 'done', and the
    // catch-all below then fired on the VERY NEXT FRAME and reset the race back
    // to 'running', wiping lap/best/opps and the result. The banner existed for
    // one frame. Worse, run.gridRace was never cleared, so the session kept
    // running as a race with the lap counter back at zero and re-paid rep and
    // prize money every time it came round again.
    //
    // The banner's RETURN HOME / RACE AGAIN both go through switchMap, which
    // calls resetTrackRace — and gameLoop now accepts Enter and the gamepad
    // there too, so this state is escapable without a mouse.
    if (run.phase === 'done') {
      // Keep the field moving so five rivals don't freeze mid-corner behind the
      // result panel; they just stop counting for anything.
      if (path && run.pTotal !== undefined) {
        for (const o of run.opps) advanceCircuitOpp(o, path, run.pTotal, dt);
      }
      return;
    }

    if (run.phase !== 'running') {
      run.phase = 'running';
      run.elapsed = 0; run.lap = 0; run.lapStart = 0;
      run.bestLap = null; run.lastLap = null; run.leftStart = false;
      run.startX = playerPx; run.startY = playerPy;
      run.opps = [];          // practice starts on an empty track
      resetLapCursor(run);
    }
    run.elapsed += dt;
    if (!path) return;        // no geometry — clock only, no laps to award

    // H1269: ONE cursor drives laps, rank and the finish. It is measured against
    // the PAINTED start/finish line, so the counter ticks over exactly where the
    // checker is drawn.
    const lineS = startLineArc(mapId, path, spec);
    const lapDone = tickLapCursor(run, path, lineS, playerPx, playerPy, speed, dt);
    const pTotal = run.pTotal ?? 0;
    for (const o of run.opps) advanceCircuitOpp(o, path, pTotal, dt);
    // Rank on the same unwrapped scale the rivals' cursors use, so a car a lap
    // down cannot read as leading. Rivals always carry `ai` here (both spawners
    // set it); -Infinity is the defensive value, since 0 would read as AHEAD of
    // a player who has not yet passed the path origin.
    run.position = 1 + run.opps.filter((o) => (o.ai ? o.ai.s : -Infinity) > pTotal).length;

    if (!lapDone) return;
    const lapTime = run.elapsed - run.lapStart;
    run.lapStart = run.elapsed;
    if (run.outLap) {
      // Out lap done — the flying lap starts NOW and the clock restarts with it.
      run.outLap = false;
      run.lap = 0;
      run.elapsed = 0;
      run.lapStart = 0;
      return;
    }
    run.lastLap = lapTime;
    if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
    // A grid race runs the spec's lap count; qualifying is one flying lap;
    // TEST LAP / free practice is open-ended and never ends (overlay.ts's own
    // description: "Open track · learn it · no timer pressure").
    if (run.gridRace && run.lap >= (spec.laps ?? 3)) {
      finishGridRace(run, life, day);
    } else if (run.qualifying) {
      finishQualifying(run);
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
        resetLapCursor(run);     // H1269: the oval laps on the cursor now
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
        // H1267: crossing the PAINTED finish line stops the clock (see
        // dragFinishY) — the checker and the timer are now the same event.
        if (playerPy >= dragFinishY(spec)) playerFinished = true;
      } else {
        // H1269: the OVAL used a byte-identical copy of the same direction-free
        // hysteresis, and it is the worse of the two exploits because the oval
        // pays prize money for a 3-lap win — a ~41 m per lap shuffle beat 3.5 km
        // of actual driving. It runs the same cursor as the circuits now; the
        // oval is a closed road like any other, so trackPathFor resolves it.
        const oPath = circuitPath(mapId);
        if (oPath) {
          const lineS = startLineArc(mapId, oPath, spec);
          if (tickLapCursor(run, oPath, lineS, playerPx, playerPy, speed, dt)) {
            const lapTime = run.elapsed - run.lapStart;
            if (run.bestLap === null || lapTime < run.bestLap) run.bestLap = lapTime;
            run.lastLap = lapTime;
            run.lapStart = run.elapsed;
            if (run.lap >= (spec.laps ?? 3)) playerFinished = true;
          }
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
