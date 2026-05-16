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

import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { TILE } from '@/config/world/tiles';
import { ROAD_CROSSINGS } from '@/world/roadCrossings';
import { getSignalStates, isStopState } from '@/world/trafficSignals';

/** Per-car state. roadIdx + segIdx + t locate the car along
 *  BASELINE_ROADS[roadIdx]'s polyline; the px/py/pAngle fields are
 *  derived per-frame for render. */
export interface TrafficCar {
  /** Index into BASELINE_ROADS. */
  roadIdx: number;
  /** Segment index within road's polyline (0..N-2). */
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
}

const TRAFFIC_COUNT = 24;
const COLORS: readonly string[] = ['#557fc0', '#c05566', '#66a855', '#c69533', '#7f8a96', '#9a6d52', '#c0b055'];
const SPEED_MIN = 70;
const SPEED_MAX = 130;

/** Civilian car sprites (no ambulance / cop / tow / semi / bike).
 *  Spawn picks one at random per car. */
const CIVILIAN_SPRITES: readonly string[] = [
  'Honda-Civic-Blue.png',
  'Honda-Accord-Heather.png',
  'Mazda-RX7-FC-Red.png',
  'Mazda-Miata-NA-Black.png',
  'Mazda-Miata-NA-Red.png',
  'Nissan-Skyline-R34-Blue.png',
  'Nissan-Silvia-Coupe.png',
  'Nissan-180via-Yellow.png',
  'Toyota-Corolla-AE86-White.png',
  'Acura-NSX-Red.png',
  'Dodge-Charger-Orange.png',
  'Dodge-SuperBee-Green.png',
  'Dodge-Viper-Blue.png',
  'Dodge-Caravan-Green.png',
  'Dodge-Ram-White.png',
  'Plymouth-Barracuda-Orange.png',
  'RUF BTR-86-Blue.png',
  'RUF CTR-Yellowbird.png',
  'RUF CTR2.png',
  'Audi-Quattro-82-White.png',
  'Ford-Taurus-Brown.png',
];

function pickRandomRoad(): number {
  // Skip roads with < 2 points (defensive — none exist in current
  // BASELINE_ROADS but the guard is cheap insurance).
  for (let tries = 0; tries < 8; tries++) {
    const idx = Math.floor(Math.random() * BASELINE_ROADS.length);
    const row = BASELINE_ROADS[idx];
    const ptCount = (row.length - 4) / 2;
    if (ptCount >= 2) return idx;
  }
  return 0;
}

function randomSpeed(): number {
  return SPEED_MIN + Math.random() * (SPEED_MAX - SPEED_MIN);
}

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function randomSprite(): string {
  return CIVILIAN_SPRITES[Math.floor(Math.random() * CIVILIAN_SPRITES.length)];
}

/** Number of segments in a road row. (length - 4 meta fields) / 2 pts
 *  / 1 segment-per-pt-pair gives `(length - 4) / 2 - 1` segments. */
function segmentCount(roadIdx: number): number {
  const row = BASELINE_ROADS[roadIdx];
  return (row.length - 4) / 2 - 1;
}

function segmentEndpoints(roadIdx: number, segIdx: number): { ax: number; ay: number; bx: number; by: number } {
  const row = BASELINE_ROADS[roadIdx];
  const base = 4 + segIdx * 2;
  return {
    ax: (row[base] as number) * TILE,
    ay: (row[base + 1] as number) * TILE,
    bx: (row[base + 2] as number) * TILE,
    by: (row[base + 3] as number) * TILE,
  };
}

function roadWidth(roadIdx: number): number {
  return (BASELINE_ROADS[roadIdx][0] as number) * TILE;
}

/** Refresh px/py/pAngle from roadIdx + segIdx + t. */
function syncPose(car: TrafficCar): void {
  const seg = segmentEndpoints(car.roadIdx, car.segIdx);
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
  const laneOffset = roadWidth(car.roadIdx) * 0.25;
  car.px = seg.ax + dx * car.t - perpX * laneOffset;
  car.py = seg.ay + dy * car.t - perpY * laneOffset;
  car.pAngle = Math.atan2(dy, dx);
}

/** Place a fresh-spawn car on a randomly-picked road + segment. */
function spawnCar(car: TrafficCar): void {
  car.roadIdx = pickRandomRoad();
  const segs = segmentCount(car.roadIdx);
  car.segIdx = Math.max(0, Math.floor(Math.random() * segs));
  car.t = Math.random();
  const s = randomSpeed();
  car.speed = s;
  car.baseSpeed = s;
  car.braking = false;
  car.color = randomColor();
  car.spriteFile = randomSprite();
  syncPose(car);
}

/** Allocate TRAFFIC_COUNT cars and place them on random roads. */
export function createTraffic(): TrafficCar[] {
  const cars: TrafficCar[] = [];
  for (let i = 0; i < TRAFFIC_COUNT; i++) {
    const car: TrafficCar = {
      roadIdx: 0,
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
  const segs = segmentCount(self.roadIdx);
  if (segs <= 0) return false;
  const selfSeg = segmentEndpoints(self.roadIdx, self.segIdx);
  const selfSegLen = Math.hypot(selfSeg.bx - selfSeg.ax, selfSeg.by - selfSeg.ay);
  let nextSegLen = 0;
  if (self.segIdx + 1 < segs) {
    const nextSeg = segmentEndpoints(self.roadIdx, self.segIdx + 1);
    nextSegLen = Math.hypot(nextSeg.bx - nextSeg.ax, nextSeg.by - nextSeg.ay);
  }
  for (const other of cars) {
    if (other === self) continue;
    if (other.roadIdx !== self.roadIdx) continue;
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
  player: { px: number; py: number } | null = null,
): void {
  // H113: sample wall-clock once per tick so every car sees the same
  // signal phase. Using Date.now() (not in-game clock) so signals
  // keep cycling even when the player is in a menu and the game
  // clock is paused — feels alive.
  const nowMs = Date.now();
  for (const car of cars) {
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
    const target = car.braking ? car.baseSpeed * BRAKE_TARGET_FRAC : car.baseSpeed;
    const k = car.braking ? BRAKE_DECEL_K : BRAKE_ACCEL_K;
    car.speed += (target - car.speed) * Math.min(1, k * dt);

    let segs = segmentCount(car.roadIdx);
    if (segs <= 0) {
      spawnCar(car);
      continue;
    }
    const seg = segmentEndpoints(car.roadIdx, car.segIdx);
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
        segs = segmentCount(car.roadIdx);
        break;
      }
    }
    syncPose(car);
  }
}
