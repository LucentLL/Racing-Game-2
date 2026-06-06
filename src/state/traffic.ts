/**
 * H17 dumb traffic — N cars, each following its road's polyline at a
 * constant speed. No AI, no collision, no driver model. Each tick the
 * car advances along its current segment; when it reaches the end of
 * a segment it moves to the next; when it reaches the end of the road
 * it picks a new random road and respawns there.
 *
 * INTENTIONALLY simpler than the monolith's traffic AI (L26663-27680,
 * full GTA-style AI with lane changes / pursuit / cop / semi / tow /
 * trailer). The scaffolds at src/world/traffic/{spawn,ai,cop,semis,tow}
 * carry the type contracts for the real port; H17 is a stop-gap so the
 * streets feel less empty while the real bodies are still TODOs.
 *
 * Lane convention: cars travel along polyline direction (+t), offset
 * perpendicular-right of the forward vector — matches US right-hand-
 * drive on a one-way polyline. Two-way traffic (half going backward
 * with perpendicular-left offset) ports with the real AI.
 */

import { TILE } from '@/config/world/tiles';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';
import { getSignalStates, isStopState } from '@/world/trafficSignals';
import { RENDER_ENTRIES } from '@/render/worldMap';

/** Per-car state. roadIdx + segIdx + t locate the car along
 *  BASELINE_ROADS[roadIdx]'s polyline; the px/py/pAngle fields are
 *  derived per-frame for render. */
export interface TrafficCar {
  /** Index into RENDER_ENTRIES at spawn time. Opaque after that — the
   *  smoothed-polyline reference cached in `.smoothed` is the authoritative
   *  source for motion, and isClosingOnPolyline compares smoothed-arrays
   *  by reference. Kept for debug + spawn-time bookkeeping. */
  roadIdx: number;
  /** H746b: cached smoothed (Catmull-Rom) polyline this car follows.
   *  Flat number[] of TILE-space coords, sourced from the RENDER_ENTRY
   *  picked at spawn. Drives traffic over the SAME path the renderer
   *  paints (not the linear baseline polyline) — without this, cars
   *  cut corners on bezier-smoothed curves and visibly drive offroad.
   *  Persists through editor rebuilds: the car follows the old polyline
   *  until the next despawn cycle, then picks a fresh entry. */
  smoothed: readonly number[];
  /** H746b: cached road width in world pixels (row[0] × TILE). Used
   *  by syncPose for the right-lane offset. Captured at spawn so we
   *  don't index back into RENDER_ENTRIES every frame. */
  roadWidthWpx: number;
  /** Segment index within the SMOOTHED polyline (0..N-2). */
  segIdx: number;
  /** Fraction along the current segment, 0..1. */
  t: number;
  /** Computed world pose, refreshed each frame. */
  px: number;
  py: number;
  pAngle: number;
  /** Current per-frame speed, world-units/sec. Modulated by the H110
   *  AI brake / accel toward baseSpeed when a forward obstacle clears
   *  or appears. */
  speed: number;
  /** H110 cruise-speed setpoint. Speed modulates toward this when the
   *  forward cone is clear; toward `baseSpeed * 0.3` when blocked.
   *  Set once at spawn from randomSpeed(); never mutated post-spawn. */
  baseSpeed: number;
  /** H110 brake-state flag. True when an obstacle (other traffic car
   *  or the player) sits within ~40 wpx in the car's forward 90° cone.
   *  Consumed by drawTrafficTailLights to switch the corner lamps
   *  from dim running-red to bright brake-red; also drives speed
   *  modulation in tickTraffic. */
  braking: boolean;
  /** Body color (used as the H17 silhouette fallback when sprite
   *  isn't ready or isn't picked). */
  color: string;
  /** PNG filename inside /cars/. Picked at spawn; null means use
   *  the colored-rect fallback. */
  spriteFile: string | null;
  /** H142: elevation of the road this car drives on, copied from
   *  BASELINE_ROADS[roadIdx][3] at spawn. 0 for ground, 4 for the
   *  elevated highways (I-485, I-77, I-85, etc.). tickTrafficCollisions
   *  skips this car when player.layerZ !== this so an I-485 cruiser
   *  doesn't crash you when you're on a surface street below. Mirrors
   *  the monolith's per-z filter at L26962 / L27001 / L27188. */
  roadZ: number;
  /** H163: true if this is a Crown Vic CMPD / State Trooper unit. */
  isCop: boolean;
  /** H165: pursuit-active flag. Set true by tickTraffic when this cop
   *  detects a speeding player in radar range; flipped false when
   *  pursuit ends (player slowed for 3+ sec OR cop > breakOff range).
   *  While true, baseSpeed × COP_PURSUIT_SPEED_MULT (target speed in
   *  the speed-modulation step) so the cop drives faster along its
   *  road. Inert when isCop=false. */
  isPursuing: boolean;
  /** H165: seconds-since-player-slowed counter. Accumulates each
   *  frame the player is below SPEED_LIMIT_WPX while a pursuit is
   *  active; ends pursuit when it crosses PURSUIT_END_SECS. Reset
   *  to 0 whenever the player goes over the limit again so the
   *  chase resumes. */
  pursuitSlowTime: number;
  /** H165: cooldown-until-next-pursuit seconds. After a pursuit
   *  ends, this counts down; the cop can't re-engage while >0.
   *  Prevents instant re-engagement on slow→fast→slow sequences. */
  pursuitCooldown: number;
  /** H168: player's |pSpeed| in wpx/s captured the instant a pursuit
   *  started — used by the ticket calculation so the fine scales
   *  with how fast the player was actually caught at, not how slow
   *  they had to be by the time the cop closed. Monolith L27484
   *  stores pursuitClockedMph the same way. Reset to 0 each new
   *  pursuit. */
  pursuitClockedSpeed: number;

  /** H704: PLAYER-IS-COP markers — set by the cop-job sim, NOT by
   *  the AI-cop pursuit. Inert when the player isn't on the
   *  TRAFFIC COP shift (default-undefined). All three are
   *  cleared on ticket issued. See src/sim/trafficCop.ts. */
  /** True while this car is the pending radar alert or the
   *  active chase target. */
  _copTargeted?: boolean;
  /** Grace-period countdown (seconds). While >0 the target
   *  drives at base speed so the player can close; at 0 the
   *  flee-multiplier kicks in. */
  _copSlowTimer?: number;
  /** True while the target is pinned at the pullover anchor
   *  during the 'bumped' phase. */
  _copStuck?: boolean;
}

/** H164/H165: cop radar squared range. Player must sit closer than
 *  this for radar detection + pursuit. 250 wpx ≈ ~50m at the
 *  4.5 gu/m world scale. */
export const COP_RADAR_R2 = 250 * 250;

/** H164/H165: speed at which radar fires + pursuit kicks in. 100
 *  wpx/s ≈ 46 mph at SCALE_MS=4.864. Single global limit; per-road
 *  limits port with the road-profile system. */
export const SPEED_LIMIT_WPX = 100;

/** H165: target-speed multiplier for cops in pursuit. 1.5× means
 *  cops accelerate toward (1.5 × their normal baseSpeed) while
 *  chasing — they pull ahead of normal traffic without going so
 *  fast they teleport across the world. */
const COP_PURSUIT_SPEED_MULT = 1.5;

/** H165: seconds the player must stay under the speed limit before
 *  a pursuit ends. Long enough to feel like a real chase; short
 *  enough that a quick brake actually escapes. */
const PURSUIT_END_SECS = 3;

/** H165: world-pixel break-off range. Once the cop drifts farther
 *  than this from the player (e.g. the player took an exit and
 *  the cop's road kept going), the chase ends regardless of player
 *  speed. Squared for the per-tick distance check. */
const PURSUIT_BREAKOFF_R2 = 600 * 600;

/** H165: seconds after a pursuit ends before the cop can re-engage.
 *  Prevents instant re-trigger on slow→fast→slow oscillation. */
const PURSUIT_COOLDOWN_SECS = 10;

/** H746: traffic pool size. 20 matches monolith L20008 — with the
 *  H746 respawn-near-player cycle keeping cars within ~70 tiles of
 *  the player, 20 is enough to feel populated; higher counts looked
 *  packed/freeway-busy in residential blocks. */
const TRAFFIC_COUNT = 20;
const COLORS: readonly string[] = ['#557fc0', '#c05566', '#66a855', '#c69533', '#7f8a96', '#9a6d52', '#c0b055'];
const SPEED_MIN = 70;
const SPEED_MAX = 130;

/** H746: respawn-near-player tuning. 1:1 with monolith L26582 + L27506.
 *  Fixed-N traffic stays useful in a Charlotte-sized world only when
 *  cars drifting > DESPAWN tiles from the player get cycled back onto
 *  a road 20-50 tiles away. Without this, 48 cars spread across 118
 *  baseline roads sit mostly far from the player and the city feels
 *  empty — user report: "I very rarely see another car." Rate-limited
 *  to 1 respawn/frame matching monolith L27508 MAX_RESPAWNS_PER_FRAME
 *  (avoids visible "group arrival" pop). */
const DESPAWN_R2 = (70 * TILE) * (70 * TILE);
const RESPAWN_MIN_R2 = (20 * TILE) * (20 * TILE);
const RESPAWN_MAX_R2 = (50 * TILE) * (50 * TILE);
const MAX_RESPAWNS_PER_FRAME = 1;

/** H163: probability a spawn picks the cop pool instead of civilian.
 *  10% feels right for a 24-car traffic count — typically 2-3 cops
 *  visible across the city at any time. Monolith L20281 uses a
 *  similar rate inside its mixed-spawn dispatch. */
const COP_SPAWN_PROB = 0.10;

/** H163: cop unit sprites — Crown Vic CMPD (Charlotte-Mecklenburg PD)
 *  + Crown Vic ST (state trooper). Both are 1999-era Ford Crown
 *  Victoria Police Interceptor (P71). spriteFileToBodyType maps
 *  "crown" to the 'cruiser' bodyType which already has size data
 *  from H157 + TRAFFIC_BODY_SIZES (24.2 × 8.9 — bigger than
 *  civilian sedans, as the real P71 was). */
const COP_SPRITES: readonly string[] = [
  'Ford-Crown-Vic-CMPD.png',
  'Ford-Crown-Vic-ST.png',
];

/** H746: civilian sprite pool, weighted toward daily-driver silhouettes.
 *  Earlier pool had ~14 sport/exotic sprites (NSX, Viper, RUFs, Skyline,
 *  Miata, RX-7, AE86, Quattro, Charger, SuperBee, Barracuda, etc.) vs
 *  6 dailies — every other car on the street looked like a racer. User
 *  report: "too high percentage of race cars instead of traffic cars."
 *  Built from two pools + a weighted pick: 85% daily-driver, 15% sport.
 *  Cops still go through the COP_SPAWN_PROB path above. */
const CIVILIAN_DAILY_SPRITES: readonly string[] = [
  'Honda-Civic-Blue.png',
  'Honda-Accord-Heather.png',
  'Ford-Taurus-Brown.png',
  'Dodge-Caravan-Green.png',
  'Dodge-Ram-White.png',
  'Freightliner-Van.png',
];
const CIVILIAN_SPORT_SPRITES: readonly string[] = [
  'Mazda-Miata-NA-Black.png',
  'Mazda-Miata-NA-Red.png',
  'Mazda-RX7-FC-Red.png',
  'Toyota-Corolla-AE86-White.png',
  'Nissan-Silvia-Coupe.png',
];
const CIVILIAN_SPORT_PROB = 0.15;

/** H746b: pick a RENDER_ENTRY at random whose smoothed polyline has at
 *  least 2 points. Returns null if the pool is empty (only at very
 *  early boot before rebuildRenderEntries runs). Replaces the prior
 *  pickRandomRoad(BASELINE_ROADS) — traffic now follows the same
 *  Catmull-Rom polyline the renderer paints so they no longer cut
 *  the inside of curves and drive off the visible asphalt. */
function pickRandomEntry(): {
  idx: number;
  smoothed: readonly number[];
  roadWidthWpx: number;
  roadZ: number;
} | null {
  const n = RENDER_ENTRIES.length;
  if (n === 0) return null;
  for (let tries = 0; tries < 8; tries++) {
    const idx = Math.floor(Math.random() * n);
    const e = RENDER_ENTRIES[idx];
    if (!e || e.smoothed.length < 4) continue;
    const w = e.row[0] as number;
    const z = e.row[3] as number;
    return { idx, smoothed: e.smoothed, roadWidthWpx: w * TILE, roadZ: z };
  }
  return null;
}

function randomSpeed(): number {
  return SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
}

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function randomSprite(): string {
  const pool = Math.random() < CIVILIAN_SPORT_PROB ? CIVILIAN_SPORT_SPRITES : CIVILIAN_DAILY_SPRITES;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** H163: cop-or-civilian draw + spritefile pick. Used at spawn time
 *  to seed both car.isCop and car.spriteFile in one shot so they
 *  stay consistent. Returns the picked filename + flag. */
function pickSpriteWithCopFlag(): { spriteFile: string; isCop: boolean } {
  if (Math.random() < COP_SPAWN_PROB) {
    return {
      spriteFile: COP_SPRITES[Math.floor(Math.random() * COP_SPRITES.length)],
      isCop: true,
    };
  }
  return { spriteFile: randomSprite(), isCop: false };
}

/** Number of segments in a car's smoothed polyline. */
function segmentCountOf(car: TrafficCar): number {
  return car.smoothed.length / 2 - 1;
}

function segmentEndpointsOf(car: TrafficCar, segIdx: number): { ax: number; ay: number; bx: number; by: number } {
  const pts = car.smoothed;
  const base = segIdx * 2;
  return {
    ax: pts[base] * TILE,
    ay: pts[base + 1] * TILE,
    bx: pts[base + 2] * TILE,
    by: pts[base + 3] * TILE,
  };
}

/** Refresh px/py/pAngle from smoothed + segIdx + t. */
function syncPose(car: TrafficCar): void {
  const seg = segmentEndpointsOf(car, car.segIdx);
  const dx = seg.bx - seg.ax;
  const dy = seg.by - seg.ay;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Right-of-forward perpendicular (rotate +90° CW in canvas coords).
  const perpX = uy;
  const perpY = -ux;
  // Offset onto the right lane — about a quarter of the road width
  // out from centerline. Enough that the car isn't ON the dashed
  // yellow stripe but not so far it clips into the shoulder.
  const laneOffset = car.roadWidthWpx * 0.25;
  car.px = seg.ax + dx * car.t - perpX * laneOffset;
  car.py = seg.ay + dy * car.t - perpY * laneOffset;
  car.pAngle = Math.atan2(dy, dx);
}

/** H746: try to place `car` on a road segment 20-50 tiles from the
 *  player. Returns true on success; false after 8 misses (caller falls
 *  back to plain spawnCar). Used by tickTraffic's respawn-cycle below
 *  to keep visible traffic populated near the player. */
function applySpawnAttrs(car: TrafficCar, entry: { idx: number; smoothed: readonly number[]; roadWidthWpx: number; roadZ: number }, segIdx: number, t: number): void {
  car.roadIdx = entry.idx;
  car.smoothed = entry.smoothed;
  car.roadWidthWpx = entry.roadWidthWpx;
  car.roadZ = entry.roadZ;
  car.segIdx = segIdx;
  car.t = t;
  const s = randomSpeed();
  car.speed = s;
  car.baseSpeed = s;
  car.braking = false;
  car.color = randomColor();
  const pick = pickSpriteWithCopFlag();
  car.spriteFile = pick.spriteFile;
  car.isCop = pick.isCop;
  car.isPursuing = false;
  car.pursuitSlowTime = 0;
  car.pursuitCooldown = 0;
  car.pursuitClockedSpeed = 0;
  syncPose(car);
}

function spawnCarNearPlayer(car: TrafficCar, playerX: number, playerY: number): boolean {
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = pickRandomEntry();
    if (!entry) return false;
    const segs = entry.smoothed.length / 2 - 1;
    if (segs <= 0) continue;
    const segIdx = Math.floor(Math.random() * segs);
    const t = Math.random();
    const base = segIdx * 2;
    const ax = entry.smoothed[base] * TILE;
    const ay = entry.smoothed[base + 1] * TILE;
    const bx = entry.smoothed[base + 2] * TILE;
    const by = entry.smoothed[base + 3] * TILE;
    const sx = ax + (bx - ax) * t;
    const sy = ay + (by - ay) * t;
    const dx = sx - playerX;
    const dy = sy - playerY;
    const d2 = dx * dx + dy * dy;
    if (d2 < RESPAWN_MIN_R2 || d2 > RESPAWN_MAX_R2) continue;
    applySpawnAttrs(car, entry, segIdx, t);
    return true;
  }
  return false;
}

/** Place a fresh-spawn car on a randomly-picked road + segment. */
function spawnCar(car: TrafficCar): void {
  const entry = pickRandomEntry();
  if (!entry) return;
  const segs = entry.smoothed.length / 2 - 1;
  const segIdx = Math.max(0, Math.floor(Math.random() * Math.max(1, segs)));
  applySpawnAttrs(car, entry, segIdx, Math.random());
}

/** Allocate TRAFFIC_COUNT cars and place them on random roads. */
export function createTraffic(): TrafficCar[] {
  const cars: TrafficCar[] = [];
  for (let i = 0; i < TRAFFIC_COUNT; i++) {
    const car: TrafficCar = {
      roadIdx: 0,
      smoothed: [],
      roadWidthWpx: 0,
      segIdx: 0,
      t: 0,
      px: 0,
      py: 0,
      pAngle: 0,
      speed: SPEED_MIN,
      baseSpeed: SPEED_MIN,
      braking: false,
      color: COLORS[0],
      spriteFile: null,
      roadZ: 0,
      isCop: false,
      isPursuing: false,
      pursuitSlowTime: 0,
      pursuitCooldown: 0,
      pursuitClockedSpeed: 0,
    };
    spawnCar(car);
    cars.push(car);
  }
  return cars;
}

/** H110 AI brake-detection params. */
const BRAKE_LOOK_REACH = 40;             // world-px forward look distance
const BRAKE_LOOK_REACH2 = BRAKE_LOOK_REACH * BRAKE_LOOK_REACH;
const BRAKE_CONE_DOT = 0.7;              // dot(heading, toObstacle); 0.7 ≈ ±45° forward
const BRAKE_TARGET_FRAC = 0.30;          // brake speed = baseSpeed × this
const BRAKE_DECEL_K = 6;                 // speed-approach rate when braking (1/s)
const BRAKE_ACCEL_K = 1.5;               // speed-approach rate when resuming
/** H112 polyline look-ahead window in world-px. Cars closing on a slower
 *  car ahead on the same polyline within this distance start braking,
 *  even if the slower car is outside the H110 geometric cone (e.g.
 *  around a curve where the line-of-sight angle is wide but the
 *  polyline distance is short). */
const POLYLINE_LOOK_REACH = 60;
/** H112 speed-delta tolerance — only treat a car ahead as a brake-
 *  obstacle when it's MEANINGFULLY slower than us. Avoids two cars
 *  cruising at identical speed in a convoy from latching each other
 *  into permanent brake mode. */
const POLYLINE_SPEED_DELTA = 5;
/** H113 traffic-signal proximity in world-px. Cars within this radius
 *  of a road crossing AND facing the red-light axis trip the brake. */
const SIGNAL_LOOK_REACH = 40;
const SIGNAL_LOOK_REACH2 = SIGNAL_LOOK_REACH * SIGNAL_LOOK_REACH;
/** H113 angle tolerance when matching a car's heading to one of the
 *  crossing's two approach axes. Cars within ±45° of an axis are
 *  considered "on" that axis. */
const SIGNAL_AXIS_TOL = Math.PI / 4;

/** H113: shortest-arc angle delta between two angles, in [0, π]. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** H113: which of a crossing's two axes does `carAngle` align with?
 *  Returns 1 for ang1, 2 for ang2, or 0 when the car isn't aligned
 *  with either (rare — happens at acute Y-junctions where neither
 *  axis is within ±45°). Tested against both `angle` and `angle+π`
 *  because an axis is direction-agnostic (a road runs both ways). */
function crossingAxisFor(car: TrafficCar, ang1: number, ang2: number): 0 | 1 | 2 {
  const d1a = angleDiff(car.pAngle, ang1);
  const d1b = angleDiff(car.pAngle, ang1 + Math.PI);
  const d1 = Math.min(d1a, d1b);
  const d2a = angleDiff(car.pAngle, ang2);
  const d2b = angleDiff(car.pAngle, ang2 + Math.PI);
  const d2 = Math.min(d2a, d2b);
  if (d1 < d2 && d1 < SIGNAL_AXIS_TOL) return 1;
  if (d2 < SIGNAL_AXIS_TOL) return 2;
  return 0;
}

/** H113/H114: does the car face a stop-signal (yellow or red) approach
 *  at any nearby crossing? Returns true on the first hit; iterates
 *  ROAD_CROSSINGS (cap ~200) with a distance² early-reject + forward
 *  dot product gate so the hot path is ~20-40 distance² compares +
 *  1-2 axis checks + 1 signal-state lookup per car. */
function isApproachingRedLight(car: TrafficCar, nowMs: number): boolean {
  const states = getSignalStates(nowMs);
  const fx = Math.cos(car.pAngle);
  const fy = Math.sin(car.pAngle);
  for (const c of ROAD_CROSSINGS) {
    const dx = c.x - car.px;
    const dy = c.y - car.py;
    const d2 = dx * dx + dy * dy;
    if (d2 > SIGNAL_LOOK_REACH2) continue;
    // Must be AHEAD of the car (forward dot product). Skip ones we've
    // already crossed.
    if (dx * fx + dy * fy <= 0) continue;
    const axis = crossingAxisFor(car, c.ang1, c.ang2);
    if (axis === 0) continue;                  // car not aligned with either
    const myState = axis === 1 ? states.ang1 : states.ang2;
    if (isStopState(myState)) return true;     // yellow + red both stop
  }
  return false;
}

/** H110: forward-cone obstacle check. Returns true if any traffic car
 *  (other than `self`) OR the player is within BRAKE_LOOK_REACH wpx
 *  and inside the ~90° forward cone of `self`. */
function isBlockedAhead(
  self: TrafficCar,
  cars: readonly TrafficCar[],
  player: { px: number; py: number } | null,
): boolean {
  const fx = Math.cos(self.pAngle);
  const fy = Math.sin(self.pAngle);
  const check = (ox: number, oy: number): boolean => {
    const dx = ox - self.px;
    const dy = oy - self.py;
    const d2 = dx * dx + dy * dy;
    if (d2 < 0.01 || d2 > BRAKE_LOOK_REACH2) return false;
    const inv = 1 / Math.sqrt(d2);
    const dot = (dx * inv) * fx + (dy * inv) * fy;
    return dot > BRAKE_CONE_DOT;
  };
  if (player && check(player.px, player.py)) return true;
  for (const other of cars) {
    if (other === self) continue;
    if (check(other.px, other.py)) return true;
  }
  return false;
}

/** H112: same-polyline predictive look-ahead. Returns true if another
 *  traffic car on the same road, at a polyline position ahead of
 *  `self`, is within POLYLINE_LOOK_REACH wpx of polyline arc-length
 *  AND is meaningfully slower than `self`. Catches the "closing on
 *  someone around a curve" case where the geometric cone check
 *  (isBlockedAhead) misses because line-of-sight angle is wide.
 *
 *  Only checks the current segment + the immediate next segment —
 *  good enough for the 24-car traffic count without an N² polyline
 *  scan exploding into N×segments. */
function isClosingOnPolyline(self: TrafficCar, cars: readonly TrafficCar[]): boolean {
  const segs = segmentCountOf(self);
  if (segs <= 0) return false;
  const selfSeg = segmentEndpointsOf(self, self.segIdx);
  const selfSegLen = Math.hypot(selfSeg.bx - selfSeg.ax, selfSeg.by - selfSeg.ay);
  let nextSegLen = 0;
  if (self.segIdx + 1 < segs) {
    const nextSeg = segmentEndpointsOf(self, self.segIdx + 1);
    nextSegLen = Math.hypot(nextSeg.bx - nextSeg.ax, nextSeg.by - nextSeg.ay);
  }
  for (const other of cars) {
    if (other === self) continue;
    if (other.smoothed !== self.smoothed) continue;
    if (other.speed >= self.speed - POLYLINE_SPEED_DELTA) continue;
    let gap: number;
    if (other.segIdx === self.segIdx) {
      if (other.t <= self.t) continue;          // behind us
      gap = (other.t - self.t) * selfSegLen;
    } else if (other.segIdx === self.segIdx + 1) {
      gap = (1 - self.t) * selfSegLen + other.t * nextSegLen;
    } else {
      continue;                                  // further ahead or behind
    }
    if (gap < POLYLINE_LOOK_REACH) return true;
  }
  return false;
}

/** Per-frame tick. Advances each car along its polyline; respawns on
 *  a new road when the current one runs out. H110 adds the AI brake
 *  detection — each car checks the forward cone for obstacles and
 *  modulates speed toward `baseSpeed × 0.3` while blocked. */
export function tickTraffic(
  cars: TrafficCar[],
  dt: number,
  player: { px: number; py: number; pSpeed?: number; speedLimit?: number } | null = null,
): void {
  // H113: sample wall-clock once per tick so every car sees the same
  // signal phase. Using Date.now() (not in-game clock) so signals
  // keep cycling even when the player is in a menu and the game
  // clock is paused — feels alive.
  const nowMs = Date.now();
  // H165: snapshot the player's absolute speed once per tick for the
  // per-cop radar check. Player param doesn't always carry pSpeed
  // (some callers pass position-only); default to 0 so the radar
  // simply never fires in that case.
  const playerSpeed = player && typeof player.pSpeed === 'number' ? Math.abs(player.pSpeed) : 0;
  // H166: per-road speed limit. gameLoop computes this once per frame
  // via playerSpeedLimitWpx(player.px, player.py) and threads it in;
  // fallback to the H164/H165 global SPEED_LIMIT_WPX when missing.
  // 10 wpx/s tolerance added below — monolith L27472 uses
  // `pSpeedMph > _speedLimit + 10`, same idea at our scale.
  const speedLimitBase = player && typeof player.speedLimit === 'number'
    ? player.speedLimit
    : SPEED_LIMIT_WPX;
  const speedLimitForRadar = speedLimitBase + 10;
  // H746: respawn-near-player cycle. Walk cars in random offset order
  // so the same low-index car doesn't always win the 1-per-frame slot.
  // Skips cars that are pursuing or player-cop-targeted — those have
  // semantic state that would be lost on respawn. Walks BEFORE the
  // main AI loop so the new pose feeds the same-frame motion update.
  let respawnedThisFrame = 0;
  if (player && cars.length > 0) {
    const start = Math.floor(Math.random() * cars.length);
    for (let i = 0; i < cars.length; i++) {
      if (respawnedThisFrame >= MAX_RESPAWNS_PER_FRAME) break;
      const car = cars[(start + i) % cars.length];
      if (car.isPursuing || car._copTargeted) continue;
      const dx = car.px - player.px;
      const dy = car.py - player.py;
      if (dx * dx + dy * dy <= DESPAWN_R2) continue;
      if (spawnCarNearPlayer(car, player.px, player.py)) respawnedThisFrame++;
    }
  }
  for (const car of cars) {
    // H165: cop pursuit state machine. Runs BEFORE the normal AI
    // brake/closing checks so the pursuing flag can influence the
    // target-speed calc below. Three sub-paths:
    //   1. cooldown >0: tick down, skip detection (cop on break).
    //   2. !pursuing: check radar (speeding + in-range) → engage.
    //   3. pursuing: tick slowTime when player under limit; end
    //      pursuit if slowTime > PURSUIT_END_SECS or distance >
    //      PURSUIT_BREAKOFF_R2. Reset slowTime if player re-speeds.
    if (car.isCop && player) {
      if (car.pursuitCooldown > 0) {
        car.pursuitCooldown = Math.max(0, car.pursuitCooldown - dt);
      } else if (!car.isPursuing) {
        const dx = car.px - player.px;
        const dy = car.py - player.py;
        if (playerSpeed > speedLimitForRadar && (dx * dx + dy * dy) < COP_RADAR_R2) {
          car.isPursuing = true;
          car.pursuitSlowTime = 0;
          // H168: snapshot the player's speed at detection — used
          // later by the ticket calc so the fine scales with the
          // clocked speed, not the slowed-by-arrest speed.
          car.pursuitClockedSpeed = playerSpeed;
        }
      } else {
        const dx = car.px - player.px;
        const dy = car.py - player.py;
        const dist2 = dx * dx + dy * dy;
        if (playerSpeed < speedLimitBase) {
          car.pursuitSlowTime += dt;
        } else {
          car.pursuitSlowTime = 0;
        }
        if (car.pursuitSlowTime >= PURSUIT_END_SECS || dist2 > PURSUIT_BREAKOFF_R2) {
          car.isPursuing = false;
          car.pursuitSlowTime = 0;
          car.pursuitCooldown = PURSUIT_COOLDOWN_SECS;
        }
      }
    }
    // H110/H112/H113: detect forward obstacle and adjust speed before
    // advancing along the polyline. Three signals OR into braking:
    //   H110 geometric cone — nearby cars + the player in any dir
    //   H112 polyline look-ahead — slower cars on the same road's
    //                              arc-length, even around curves
    //   H113 red-light approach  — a road crossing within ~40 wpx
    //                              forward whose green axis is the
    //                              perpendicular one to our heading
    // Faster decel when braking (k=6 ≈ 165ms to settle) than accel
    // when resuming (k=1.5 ≈ 660ms) — "slam brakes, ease back into gas".
    car.braking = isBlockedAhead(car, cars, player)
      || isClosingOnPolyline(car, cars)
      || isApproachingRedLight(car, nowMs);
    // H165: pursuing cops override the brake check — they're chasing,
    // they don't slow for civilians (and they accelerate to 1.5× base
    // via the target multiplier below). Realistic? No. Visible?
    // Strongly — cops weave through traffic at speed.
    if (car.isPursuing) car.braking = false;
    const pursuitMult = car.isPursuing ? COP_PURSUIT_SPEED_MULT : 1;
    const target = car.braking
      ? car.baseSpeed * BRAKE_TARGET_FRAC
      : car.baseSpeed * pursuitMult;
    const k = car.braking ? BRAKE_DECEL_K : BRAKE_ACCEL_K;
    car.speed += (target - car.speed) * Math.min(1, k * dt);

    let segs = segmentCountOf(car);
    if (segs <= 0) {
      spawnCar(car);
      continue;
    }
    const seg = segmentEndpointsOf(car, car.segIdx);
    const segLen = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay);
    if (segLen <= 0.001) {
      // Degenerate segment — skip forward.
      car.segIdx++;
      if (car.segIdx >= segs) spawnCar(car);
      continue;
    }
    car.t += (car.speed * dt) / segLen;
    while (car.t >= 1) {
      car.t -= 1;
      car.segIdx++;
      if (car.segIdx >= segs) {
        spawnCar(car);
        segs = segmentCountOf(car);
        break;
      }
    }
    syncPose(car);
  }
}
