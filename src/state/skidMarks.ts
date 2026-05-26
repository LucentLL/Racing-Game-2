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

/** Per-frame spawn step. Call after arcadeUpdate so player.pAngle /
 *  pSpeed are current. nowMs is Date.now() — caller passes once so
 *  multiple per-frame spawns share the same timestamp. carSize is the
 *  active car's [length, width] in game units, used to place the rear-
 *  axle skid contact at the actual tire position (H258 — previously
 *  hardcoded to the legacy 22×14 placeholder, which spawned marks
 *  outside every real chassis's visible body). */
export function spawnSkidMarksIfNeeded(
  state: SkidMarkState,
  player: { px: number; py: number; pAngle: number; pSpeed: number },
  input: { gas: boolean; brake: boolean },
  onRoad: boolean,
  nowMs: number,
  carSize: readonly [number, number] = [22, 14],
  /** H675: optional rear-axle geometry override. When supplied, skid
   *  marks anchor to (rAxleX, ±rHalfTrack) in car-local frame —
   *  matching the X-Ray tire render's wheelbase-derived positions.
   *  Without this, the carSize-based fallback puts marks ~1-2 units
   *  off where the X-Ray tires actually sit (legacy WHEEL_INSET=3
   *  hack vs the real GT4 wheelbase). Caller computes via
   *  xrayWheelGeomFromSpec and passes { x: geom.rAxleX, halfTrack:
   *  geom.rHalfTrack }. */
  rearAxleOverride?: { x: number; halfTrack: number },
): void {
  // Throttle to 33 Hz so a 1s brake spawns ~33 marks, not 60.
  if (nowMs - state.lastSpawnMs < 30) return;

  // Trigger conditions:
  //   - hard brake at speed → rear-wheel lock
  //   - gas from near-stop → rear-wheel burnout
  const hardBrake = input.brake && player.pSpeed > 60;
  const burnout = input.gas && !input.brake && player.pSpeed < 30 && player.pSpeed > 1;
  if (!hardBrake && !burnout) return;
  state.lastSpawnMs = nowMs;

  // Rear-axle position in car-local. H675: prefer GT4-derived geom
  // when available so skid marks land exactly under the X-Ray tires;
  // fall back to the legacy carSize-with-WHEEL_INSET approximation
  // for pre-life or non-GT4 cars.
  const WHEEL_INSET = 3;
  const axleX = rearAxleOverride
    ? rearAxleOverride.x
    : -(carSize[0] / 2 - WHEEL_INSET);
  const halfTrack = rearAxleOverride
    ? rearAxleOverride.halfTrack
    : carSize[1] / 2;
  const cos = Math.cos(player.pAngle);
  const sin = Math.sin(player.pAngle);
  const px = player.px + cos * axleX;
  const py = player.py + sin * axleX;
  // Perpendicular for the side offset.
  const pcos = -sin;
  const psin = cos;
  for (const side of [-1, 1] as const) {
    pushMark(state, {
      x: px + pcos * halfTrack * side,
      y: py + psin * halfTrack * side,
      r: hardBrake ? 1.0 : 0.7,
      onRoad,
    });
  }
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
