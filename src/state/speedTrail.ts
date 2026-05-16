/**
 * H56 — Akira-style taillight trail.
 *
 * At high speed at night, the player's tail lights leave glowing red
 * streaks behind the car. Length scales linearly with speed from 0 at
 * THRESH up to MAX_LEN at MAX_SPEED. When braking, the trail thickens
 * and brightens.
 *
 * Ported from monolith speedTrail array (L20026) + per-frame push
 * (L26318-26353) + render pass (L31779-31818) in simplified form.
 *
 * Storage: a short list of trail points (~5-15 typical). Each frame
 * pushes one point and trims old points whose accumulated distance
 * exceeds the speed-scaled budget.
 */

export interface TrailPoint {
  /** World-coord position of the rear taillight center. */
  x: number;
  y: number;
  /** Heading at the time the point was pushed. */
  a: number;
  /** Half-width to the side taillight at the time of push. */
  hw: number;
  /** True if the brake was held — drives bloom intensity at render. */
  brake: boolean;
}

export interface SpeedTrailState {
  points: TrailPoint[];
}

export function createSpeedTrailState(): SpeedTrailState {
  return { points: [] };
}

/** Speed threshold (world-units/sec) below which the trail starts to
 *  collapse. ~70% of MAX_SPEED so highway driving lights it up. */
export const TRAIL_THRESH = 140;
/** Cap on internal speed for trail-length scaling. */
const TRAIL_MAX_SPEED = 200;
/** Maximum trail tail length in world units at full speed. */
const TRAIL_MAX_LEN = 70;
/** Hard cap to keep the array bounded under degenerate cases. */
const TRAIL_HARD_CAP = 60;

/** Per-frame tick. Pushes a new point when above threshold, shifts
 *  off old ones to keep length within speed-budget. Below threshold,
 *  shifts off one per frame so the tail fades away smoothly. */
export function tickSpeedTrail(
  state: SpeedTrailState,
  player: { px: number; py: number; pAngle: number; pSpeed: number },
  braking: boolean,
): void {
  if (player.pSpeed > TRAIL_THRESH) {
    const cos = Math.cos(player.pAngle);
    const sin = Math.sin(player.pAngle);
    // Rear taillight pair anchor: ~11 world units behind center (matches
    // playerCar.ts CAR_LEN/2 + a touch).
    const tailOff = 11;
    state.points.push({
      x: player.px - cos * tailOff,
      y: player.py - sin * tailOff,
      a: player.pAngle,
      hw: 6, // ~CAR_W/2 - 1
      brake: braking,
    });
    // Trim by accumulated tail length budget.
    const frac = Math.min(1, (player.pSpeed - TRAIL_THRESH) / (TRAIL_MAX_SPEED - TRAIL_THRESH));
    const maxDist = frac * TRAIL_MAX_LEN;
    while (state.points.length > 2) {
      let total = 0;
      for (let i = state.points.length - 1; i > 0; i--) {
        const dx = state.points[i].x - state.points[i - 1].x;
        const dy = state.points[i].y - state.points[i - 1].y;
        total += Math.sqrt(dx * dx + dy * dy);
      }
      if (total <= maxDist) break;
      state.points.shift();
    }
    if (state.points.length > TRAIL_HARD_CAP) state.points.shift();
  } else if (state.points.length > 0) {
    state.points.shift();
  }
}

/** Paint the trail. Two parallel red lines for left + right tail
 *  lights, with alpha fading from old → new and a thicker bloom
 *  layer when the brake was held. Skip below 2 points (can't form a
 *  segment). */
export function drawSpeedTrail(
  ctx: CanvasRenderingContext2D,
  state: SpeedTrailState,
  intensity: number,
): void {
  const pts = state.points;
  if (pts.length < 2 || intensity <= 0.02) return;
  for (let i = 0; i < pts.length - 1; i++) {
    const t0 = pts[i];
    const t1 = pts[i + 1];
    const frac = i / pts.length;
    const brkBoost = t1.brake ? 1.8 : 1.0;
    const alpha = frac * 0.45 * brkBoost * intensity;
    const w = (0.5 + frac * 1.5) * brkBoost;
    const perp0x = -Math.sin(t0.a);
    const perp0y =  Math.cos(t0.a);
    const perp1x = -Math.sin(t1.a);
    const perp1y =  Math.cos(t1.a);
    for (const s of [-1, 1] as const) {
      const x0 = t0.x + perp0x * t0.hw * s;
      const y0 = t0.y + perp0y * t0.hw * s;
      const x1 = t1.x + perp1x * t1.hw * s;
      const y1 = t1.y + perp1y * t1.hw * s;
      ctx.strokeStyle = `rgba(255, 0, 0, ${Math.min(1, alpha)})`;
      ctx.lineWidth = w * 0.8;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      if (t1.brake) {
        ctx.strokeStyle = `rgba(255, 20, 20, ${alpha * 0.25})`;
        ctx.lineWidth = w * 2;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }
  }
}
