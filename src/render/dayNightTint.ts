/**
 * Day/night tint overlay — translucent color rect painted as a final
 * pass over the world canvas. Color blends between four keyframes
 * based on `timeOfDay`:
 *
 *   0.00  midnight   — deep blue, ~78% alpha (H1078: was 55%)
 *   0.20  pre-dawn   — fading toward dawn
 *   0.27  dawn       — warm orange, ~25% alpha
 *   0.45  late morn  — clear
 *   0.55  early aft  — clear
 *   0.73  golden hr  — warm orange, ~30% alpha
 *   0.82  dusk       — fading toward night
 *   1.00  midnight   — wraps
 *
 * Keyframes are linearly interpolated. The keyframe table is
 * intentionally sparse — adding a step is just appending a row.
 *
 * INTENTIONALLY simpler than the monolith's render() night-tint pass
 * (L31186-31228 area, uses headlight cones + per-tile shadow). H14
 * is one flat fillRect over the main canvas; per-light bloom etc.
 * lands with the proper render port.
 */

// H1078: night alphas raised (midnight 0.55 → 0.78) — unlit roads read
// properly DARK now (user report: "roads are notoriously dark when
// headlights are not on"). The post-tint beam lift in gameLoop re-draws
// headlight cones OVER this tint with 'lighter' so lit road stays lit;
// street/parking-lot lights are the planned content answer for the rest.
// H1175: the deep 0.78 navy used to exist only AT the midnight wrap —
// the rest of the night ramped through 0.52..0.75, so regular nights
// never reached the darkness of the force-night drag/oval venues
// (which pin timeOfDay = 0). User: "I really like how dark it is at
// night in Drag mode — I wish it was this dark in the other modes."
// The plateau rows at 0.88 / 0.12 hold the midnight tint through the
// core night; dusk (0.82) and pre-dawn (0.20) transitions unchanged.
const TINT_KEYFRAMES: readonly [t: number, r: number, g: number, b: number, a: number][] = [
  [0.00,   0,   5,  35, 0.78],  // midnight — dark navy
  [0.12,   0,   5,  35, 0.78],  // late-night plateau end (H1175)
  [0.20,  10,  20,  60, 0.64],  // pre-dawn
  [0.27, 220, 110,  40, 0.25],  // sunrise — warm orange
  [0.45,   0,   0,   0, 0.00],  // late morning — clear
  [0.55,   0,   0,   0, 0.00],  // early afternoon — clear
  [0.73, 230,  90,  20, 0.30],  // golden hour
  [0.82,  60,  30,  50, 0.52],  // dusk — purple-orange
  [0.88,   0,   5,  35, 0.78],  // night plateau start (H1175)
  [1.00,   0,   5,  35, 0.78],  // back to midnight (wrap)
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function tintAt(timeOfDay: number): { r: number; g: number; b: number; a: number } {
  // Find the two surrounding keyframes.
  for (let i = 0; i < TINT_KEYFRAMES.length - 1; i++) {
    const [t0, r0, g0, b0, a0] = TINT_KEYFRAMES[i];
    const [t1, r1, g1, b1, a1] = TINT_KEYFRAMES[i + 1];
    if (timeOfDay >= t0 && timeOfDay <= t1) {
      const span = t1 - t0;
      const f = span > 0 ? (timeOfDay - t0) / span : 0;
      return {
        r: lerp(r0, r1, f),
        g: lerp(g0, g1, f),
        b: lerp(b0, b1, f),
        a: lerp(a0, a1, f),
      };
    }
  }
  // Out of bounds (shouldn't hit) — pitch black fallback.
  return { r: 0, g: 0, b: 0, a: 0 };
}

/** H1148: the tint's alpha at a given time — how DARK the night overlay
 *  is (0 = clear day, ~0.78 = deep midnight / force-night drag+oval).
 *  gameLoop reads this to scale the post-tint emissive lift so headlights,
 *  tail glow, and the Akira trail shine BRIGHTER the darker it gets,
 *  instead of being buried by a heavier tint. */
export function tintAlphaAt(timeOfDay: number): number {
  return tintAt(timeOfDay).a;
}

/** Paints a translucent tint over the supplied canvas. Caller has
 *  ALREADY drawn the world. Uses an identity transform so the rect
 *  covers the full viewport regardless of any camera translate. */
export function applyDayNightTint(ctx: CanvasRenderingContext2D, timeOfDay: number, w: number, h: number): void {
  const c = tintAt(timeOfDay);
  if (c.a <= 0.001) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a.toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
