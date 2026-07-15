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
  /** H1158: full car half-width at the time of push — per-lamp lateral
   *  offsets are `lamps[i] * hw` (was pre-baked `carHalfW * 0.72`). */
  hw: number;
  /** True if the brake was held — drives bloom intensity at render. */
  brake: boolean;
  /** H820: true for motorcycles — render a SINGLE centered trail
   *  instead of the dual left/right taillight streaks. A bike has one
   *  tail lamp; the dual trail read as two parallel Akira streaks. */
  bike: boolean;
}

/** H1158: generic two-corner-lamp layout (fractions of half-width) —
 *  the fallback when the active car has no brakeLamps.ts entry. */
export const DEFAULT_TRAIL_LAMPS: readonly number[] = [-0.72, 0.72];

export interface SpeedTrailState {
  points: TrailPoint[];
  /** H1158: active car's brake-lamp lateral offsets as fractions of
   *  half-width — one trail streak per lamp (a Skyline gets four).
   *  Refreshed each tick so a car switch retargets the whole trail;
   *  the visible tail is sub-second, so old points re-rendering under
   *  the new layout is imperceptible. */
  lamps: readonly number[];
}

export function createSpeedTrailState(): SpeedTrailState {
  return { points: [], lamps: DEFAULT_TRAIL_LAMPS };
}

/** Speed threshold (world-units/sec) below which the trail starts to
 *  collapse. ~70% of MAX_SPEED so highway driving lights it up.
 *  H805: ×1.29 with the unified speed scale (same mph trigger). */
export const TRAIL_THRESH = 181;
/** Cap on internal speed for trail-length scaling. */
const TRAIL_MAX_SPEED = 258;
/** Maximum trail tail length in world units at full speed. */
const TRAIL_MAX_LEN = 70;
/** Hard cap to keep the array bounded under degenerate cases. */
const TRAIL_HARD_CAP = 60;

/** Per-frame tick. Pushes a new point when above threshold, shifts
 *  off old ones to keep length within speed-budget. Below threshold,
 *  shifts off one per frame so the tail fades away smoothly.
 *
 *  H685: takes the active car's half-length / half-width so the trail
 *  anchors at the ACTUAL rear bumper (was a hardcoded 11/6 sized for
 *  the H146 [22, 8] placeholder — every other car had a gap because
 *  its real rear was several units further back than that constant).
 *  Optional with the same hardcoded fallback so pre-life callers (no
 *  active car yet) still work. */
export function tickSpeedTrail(
  state: SpeedTrailState,
  player: { px: number; py: number; pAngle: number; pSpeed: number },
  braking: boolean,
  carHalfLen: number = 11,
  carHalfW: number = 6,
  /** H820: motorcycle flag → single centered trail at render. */
  isBike: boolean = false,
  /** H1158: brake-lamp lateral offsets (fractions of half-width) from
   *  brakeLamps.ts — one streak per lamp at render. */
  lampFracs: readonly number[] = DEFAULT_TRAIL_LAMPS,
): void {
  state.lamps = lampFracs;
  if (player.pSpeed > TRAIL_THRESH) {
    const cos = Math.cos(player.pAngle);
    const sin = Math.sin(player.pAngle);
    // Rear-bumper anchor: exactly carHalfLen behind the chassis center,
    // matching gameLoop's brake-light halo at _tlCx/_tlCy. With the H685
    // active-car wiring, the trail's newest segment lands at the same
    // pixel as the rear lamp glow.
    state.points.push({
      x: player.px - cos * carHalfLen,
      y: player.py - sin * carHalfLen,
      a: player.pAngle,
      // H1158: full half-width; each lamp streak offsets by
      // lamps[i] * hw at render (default corners ±0.72 match the
      // brake-halo placement `_tlOff = _carHalfW * 0.72`).
      hw: carHalfW,
      brake: braking,
      bike: isBike,
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

/** Paint the trail. One thin red streak per brake lamp (default: the
 *  two corner lamps; quad-tail cars like a Skyline get four), alpha
 *  fading old → new, brighter + thicker while the brake was held.
 *
 *  H1158 thickness rework (user report: "too thick / braking becomes
 *  massive"): the old normal core (0.8·w) is now the BRAKING look, the
 *  new normal is half that, and the 2×-width brake bloom stroke is
 *  gone entirely. Ratios: normal 0.4·w core, brake 0.8·w core +
 *  1.3× alpha (was 1.8× width AND alpha, plus a 2·w bloom pass). */
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
    // H685: parameterize on (i+1)/(N-1) so the segment between pts[N-2]
    // and pts[N-1] (the one whose t1 is the LATEST tail-light position)
    // hits frac = 1. Pre-H685 frac maxed at (N-2)/N (≈ 0.9 for N=10),
    // so the newest-segment alpha capped around 0.4 — visibly dim
    // exactly where the user expects the trail to anchor brightly on
    // the brake-light glow.
    const frac = (i + 1) / Math.max(1, pts.length - 1);
    // H685: alpha now lerps 0.2 (oldest) → 0.7 (newest) so the trail
    // stays visible at every segment instead of fading to zero at the
    // far end (the linear fade-to-zero at the OLD end was correct in
    // principle but combined with the off-by-one above it left the
    // first few car lengths behind the bumper effectively invisible).
    const alpha = (0.2 + 0.5 * frac) * (t1.brake ? 1.3 : 1.0) * intensity;
    const w = (0.5 + frac * 1.5) * (t1.brake ? 0.8 : 0.4);
    // H820: bikes emit ONE centered streak (single tail lamp); cars
    // emit one streak per brake lamp (H1158 — state.lamps fractions).
    const sides: readonly number[] = t1.bike ? [0] : state.lamps;
    const perp0x = -Math.sin(t0.a);
    const perp0y =  Math.cos(t0.a);
    const perp1x = -Math.sin(t1.a);
    const perp1y =  Math.cos(t1.a);
    ctx.lineWidth = w;
    ctx.strokeStyle = `rgba(255, 0, 0, ${Math.min(1, alpha)})`;
    for (const s of sides) {
      const x0 = t0.x + perp0x * t0.hw * s;
      const y0 = t0.y + perp0y * t0.hw * s;
      const x1 = t1.x + perp1x * t1.hw * s;
      const y1 = t1.y + perp1y * t1.hw * s;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
  }
}
