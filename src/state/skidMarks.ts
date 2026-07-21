/**
 * H48 — persistent tire-mark trail.
 *
 * Ported from monolith L17672 (skidMarks array) + L24517-24544 (spawn
 * logic) + L31694-31700 (render). Simplified for the arcade physics:
 * the monolith spawns marks from a real lateral-slip + axle drivetrain
 * model; we trigger on (brake at speed) and (gas from low speed) since
 * arcadeUpdate has no slip model.
 *
 * Storage: a single ring-style array capped at MAX_SKIDS. Each mark is
 * a {x, y, r, onRoad} record — the renderer paints a r×2 r×2 square at
 * (x,y). The monolith does the same.
 *
 * Memory budget: 800 × ~40 B ≈ 32 KB. Trivial.
 */

const MAX_SKIDS = 800;

export interface SkidMark {
  /** World-coord position of the contact patch. */
  x: number;
  y: number;
  /** Half-size of the painted square. */
  r: number;
  /** True if the tire was on a road tile when spawned (drives color). */
  onRoad: boolean;
}

export interface SkidMarkState {
  marks: SkidMark[];
  /** ms epoch — last frame we spawned a mark. Throttles emission so a
   *  long brake doesn't fill the 800-cap in one second. */
  lastSpawnMs: number;
  /** H55 — last frame we spawned off-road dust. Throttles dust to
   *  25 Hz so the pool doesn't fill in one second of grass driving. */
  lastDustMs: number;
}

export function createSkidMarkState(): SkidMarkState {
  return { marks: [], lastSpawnMs: 0, lastDustMs: 0 };
}

/** Add a mark, evicting the oldest when the cap is exceeded. Matches
 *  the monolith's `if(length>800) splice(0, length-800)` behavior. */
function pushMark(state: SkidMarkState, m: SkidMark): void {
  state.marks.push(m);
  if (state.marks.length > MAX_SKIDS) {
    state.marks.splice(0, state.marks.length - MAX_SKIDS);
  }
}

/** H825: push a single skid mark at a world point. Used by the traffic
 *  collision-knockback path (traffic.ts) to lay rubber when a shoved
 *  car's tires break loose laterally — the player skid spawner above is
 *  input-driven and player-only, so traffic needs this direct entry.
 *  Eviction via the same MAX_SKIDS cap; callers throttle their own
 *  emission rate. */
export function addSkidMark(state: SkidMarkState, x: number, y: number, r: number, onRoad: boolean): void {
  pushMark(state, { x, y, r, onRoad });
}

/** Which axle(s) the visible smoke/skids spawn from for a given
 *  trigger. Drive axle is the one that puts power down — only it
 *  spins on a burnout. Hard brake lock is rear-dominant for all
 *  drivetrains because forward weight transfer unloads the rear.
 *
 *    'F'  — front axle only (FWD burnout)
 *    'R'  — rear axle only (RWD/MR/RR burnout; all hard-brake locks)
 *    'B'  — both axles (4WD burnout, off-road dust) */
export type SkidAxle = 'F' | 'R' | 'B';

/** Front + rear axle positions in car-local frame (game units).
 *  Caller resolves via xrayWheelGeomFromSpec when a GT4 row exists;
 *  the carSize fallback path can compute the rear from
 *  -(carSize[0]/2 - WHEEL_INSET) and front from the +symmetric value. */
export interface AxleGeom {
  rAxleX: number;
  rHalfTrack: number;
  fAxleX: number;
  fHalfTrack: number;
}

/** Map a GT4 drivetrain string to the burnout drive axle. H710:
 *  the H48 spawn code hard-coded rear, so FWD cars (Civic, Beat,
 *  Mira, etc.) emitted burnout smoke / skids out the rear like a
 *  muscle car. */
export function driveAxleFor(drv: string): SkidAxle {
  if (drv === 'FF') return 'F';
  if (drv === '4WD') return 'B';
  return 'R'; // 'FR' / 'MR' / 'RR' / unknown default
}

/** Per-frame spawn step. Call after arcadeUpdate so player.pAngle /
 *  pSpeed are current. nowMs is Date.now() — caller passes once so
 *  multiple per-frame spawns share the same timestamp. carSize is the
 *  active car's [length, width] in game units, used to place the
 *  axle skid contact at the actual tire position (H258 — previously
 *  hardcoded to the legacy 22×14 placeholder, which spawned marks
 *  outside every real chassis's visible body).
 *
 *  H710: drivetrain-aware drive axle. Burnouts spawn at the FRONT
 *  for FWD, at BOTH for 4WD, and at the REAR for everything else;
 *  hard-brake lockups always spawn at the rear (forward weight
 *  transfer unloads it). Without this, FWD cars left "muscle car"
 *  burnout trails out the rear, which contradicted the GT4-spec
 *  drivetrain the physics already honored. */
/** Burnout / hard-brake / e-brake-lockup trigger thresholds. The
 *  spawner used to fire on the boolean input.gas / input.brake / input.ebrk
 *  fields, which mergeInputs sets to `_gasAnalog > 0.02` — so a 3 % trigger
 *  pull on a controller produced the same burnout trail as flooring it.
 *  Skids should require a real demand: a heavy boot on the throttle to
 *  break the rears loose, a hard stomp to lock the brakes, a firm pull
 *  on the handbrake. Tuned conservatively — drift skids from steering
 *  slip will land in a later hop alongside the real tire model. */
const BURNOUT_GAS_THRESH = 0.7;
const HARD_BRAKE_THRESH = 0.7;
const EBRAKE_LOCK_THRESH = 0.5;

export function spawnSkidMarksIfNeeded(
  state: SkidMarkState,
  player: { px: number; py: number; pAngle: number; pSpeed: number },
  input: {
    gas: boolean;
    brake: boolean;
    ebrk: boolean;
    /** Analog 0..1 amounts populated by mergeInputs. Optional so legacy
     *  callers (tests, external tools) still type-check; the function
     *  falls back to the boolean as 0/1 when these are absent. */
    gasAmount?: number;
    brakeAmount?: number;
    ebrkAmount?: number;
  },
  onRoad: boolean,
  nowMs: number,
  carSize: readonly [number, number] = [22, 14],
  /** H675/H710: optional GT4-derived front+rear axle geometry. When
   *  supplied, skid marks anchor to the X-Ray tire positions. When
   *  absent the carSize-with-WHEEL_INSET fallback fires for both
   *  axles symmetrically. */
  axleGeom?: AxleGeom,
  /** H687: bike flag — when true, spawn ONE centerline skid mark
   *  instead of the default left + right pair. Bikes have a single
   *  rear wheel on the chassis centerline, so two parallel skids
   *  read wrong. */
  isBike: boolean = false,
  /** H710: drive axle from the active car's GT4 drivetrain. Defaults
   *  to 'R' (legacy behavior) for callers that don't yet pass one. */
  driveAxle: SkidAxle = 'R',
  /** H1214: the grip-vs-force wheelspin signal (frictionCircle
   *  detectWheelspinRatio: requested drive force vs the friction-circle
   *  budget) for the frame, when the Phase 0B integrator owned it. */
  wheelspinRatio?: number,
  /** H1214: whether the Phase 0B integrator owned this frame — when
   *  true, burnout requires ACTUAL wheelspin (ratio > 0.15) instead of
   *  the flat gasA > 0.7 heuristic. Keyboard always feeds gasAmount=1,
   *  so under the old flag every tap of W below 30 speed spawned
   *  burnout smoke/skids regardless of whether the car could break
   *  traction ("spin tires like wide open throttle at 10% press"). */
  physicsOwned: boolean = false,
): void {
  // Throttle to 33 Hz so a 1s brake spawns ~33 marks, not 60.
  if (nowMs - state.lastSpawnMs < 30) return;

  const gasA = input.gasAmount ?? (input.gas ? 1 : 0);
  const brakeA = input.brakeAmount ?? (input.brake ? 1 : 0);
  const ebrkA = input.ebrkAmount ?? (input.ebrk ? 1 : 0);

  // Trigger conditions — each fires independently so a player who
  // holds gas + e-brake on a FWD car gets BOTH front burnout
  // (drive axle wheelspin) AND rear lockup (mechanical ebrk).
  //   - hard brake at speed → lockup (rear-dominant across drivetrains)
  //   - gas from near-stop → drive-axle burnout
  //   - e-brake at speed → rear lockup (mechanical, drivetrain-
  //     independent) [H711]
  const hardBrake = brakeA > HARD_BRAKE_THRESH && player.pSpeed > 60;
  // H1214: with the integrator active, burnout = real wheelspin (force
  // exceeded grip); the gasA heuristic survives only as the arcade
  // fallback for frames the tire model didn't run.
  const burnoutDemand = physicsOwned
    ? (wheelspinRatio ?? 0) > 0.15
    : gasA > BURNOUT_GAS_THRESH;
  const burnout = burnoutDemand && brakeA < 0.1 && player.pSpeed < 30 && player.pSpeed > 1;
  const ebrakeLock = ebrkA > EBRAKE_LOCK_THRESH && player.pSpeed > 30;
  if (!hardBrake && !burnout && !ebrakeLock) return;
  state.lastSpawnMs = nowMs;

  // Resolve front + rear positions in car-local. Prefer GT4-derived
  // geom when available; fall back to the symmetric carSize layout
  // for pre-life / non-GT4 cars.
  const WHEEL_INSET = 3;
  const rAxleX = axleGeom ? axleGeom.rAxleX : -(carSize[0] / 2 - WHEEL_INSET);
  const fAxleX = axleGeom ? axleGeom.fAxleX :  (carSize[0] / 2 - WHEEL_INSET);
  const rHalfTrack = axleGeom ? axleGeom.rHalfTrack : carSize[1] / 2;
  const fHalfTrack = axleGeom ? axleGeom.fHalfTrack : carSize[1] / 2;

  // Which axles emit THIS frame. Triggers stack — e.g. burnout +
  // ebrk on FWD spawns front (burnout drive axle) AND rear (ebrk
  // mechanical lockup).
  let emitFront = false;
  let emitRear = false;
  if (hardBrake) emitRear = true;
  if (ebrakeLock) emitRear = true;
  if (burnout) {
    if (driveAxle === 'F' || driveAxle === 'B') emitFront = true;
    if (driveAxle === 'R' || driveAxle === 'B') emitRear = true;
  }

  const cos = Math.cos(player.pAngle);
  const sin = Math.sin(player.pAngle);
  const pcos = -sin;
  const psin = cos;

  // H687: bikes get a single centerline mark; cars get the left + right pair.
  // Heavier mark for the lockup-style triggers (hard brake + ebrk);
  // burnout-only emission stays at the lighter 0.7.
  const heavyMark = hardBrake || ebrakeLock;
  const sides: ReadonlyArray<-1 | 0 | 1> = isBike ? [0] : [-1, 1];
  const emitAt = (ax: number, ht: number): void => {
    const baseX = player.px + cos * ax;
    const baseY = player.py + sin * ax;
    for (const side of sides) {
      pushMark(state, {
        x: baseX + pcos * ht * side,
        y: baseY + psin * ht * side,
        r: heavyMark ? 1.0 : 0.7,
        onRoad,
      });
    }
  };

  if (emitFront) emitAt(fAxleX, fHalfTrack);
  if (emitRear) emitAt(rAxleX, rHalfTrack);
}

/** Paints all marks within `radius` of the player so off-screen marks
 *  don't burn draw cost. Caller has applied the camera transform; we
 *  draw in world coords. */
export function drawSkidMarks(
  ctx: CanvasRenderingContext2D,
  state: SkidMarkState,
  centerX: number,
  centerY: number,
  radius: number,
): void {
  const r2 = radius * radius;
  for (const m of state.marks) {
    const dx = m.x - centerX;
    const dy = m.y - centerY;
    if (dx * dx + dy * dy > r2) continue;
    ctx.fillStyle = m.onRoad ? 'rgba(15,15,15,0.55)' : 'rgba(80,50,20,0.5)';
    ctx.fillRect(m.x - m.r, m.y - m.r, m.r * 2, m.r * 2);
  }
}
