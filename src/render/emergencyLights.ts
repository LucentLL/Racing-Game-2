/**
 * H1190–H1197 — shared emergency-vehicle lighting.
 *
 * `illuminateEmergencyLights` does NOT draw a light bar. Emergency
 * vehicles already have their light fixtures BAKED into the sprite art
 * (the Crown-Vic cruiser's blue roof bar; the ambulance's red junction
 * band + rear lamps). This adds only additive ('lighter') radial glows —
 * a soft bloom + a bright core — ON those fixtures so they read as
 * switched-ON lamps (user H1196: "illuminate the lights of the car
 * sprites, not added light bars").
 *
 * H1197: the glow is drawn TWICE per frame — a faint pre-tint pass (on
 * the body, for daylight) and a BRIGHT post-tint pass lifted over the
 * night tint with a `gain` boost, exactly like the Akira speed trail —
 * because additive light on the ambulance's white body pre-tint is
 * clamped to white and then buried by the night tint (user: "barely
 * noticeable... should be bright almost like the Akira trails").
 *
 * NC color law: police flashes BLUE ONLY (no red); an ambulance flashes
 * RED ONLY (no blue). Lamps wig-wag driver↔passenger (left↔right side).
 *
 * `emergencyWash` tints a nearby car BODY with the pulsing emergency
 * color (light reflecting off other cars). Cop = blue; ambulance = red;
 * braking car = steady deep red — and a brake source only washes cars
 * BEHIND the braking car (its own body + cars ahead are excluded), so a
 * braking car lights only its own rear + the front of the car following.
 */

import { traceBodyRoundRect } from './carLighting';

/** RGB triples. Saturated so the additive core reads as a hot lamp. */
const COP_BLUE: readonly [number, number, number] = [90, 160, 255];
const AMB_RED: readonly [number, number, number] = [255, 45, 35];
const BRAKE: readonly [number, number, number] = [255, 30, 20];

/** 'cop' = blue-only police strobe; 'red' = ambulance red strobe; 'brake'
 *  = steady deep-red tail lamp. */
export type EmergencyMode = 'cop' | 'red' | 'brake';

/** Which set of baked fixtures to light up. */
export type EmergencyKind = 'cop' | 'ambulance';

/** One baked lamp in the car's local frame (fractions applied by caller).
 *  `side` <0 = driver, >0 = passenger — drives the wig-wag phase. */
interface Lamp { x: number; y: number; r: number; }

/** Additive lamp = soft bloom halo + bright core, both 'lighter'. `a` is
 *  the (already gain-scaled, 0..1) peak alpha. */
function glowBulb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rgb: readonly [number, number, number],
  a: number,
): void {
  const [R, G, B] = rgb;
  // Bloom — wide, soft, gives the Akira-style halo around the lamp.
  const br = r * 2.3;
  const bloom = ctx.createRadialGradient(cx, cy, 0, cx, cy, br);
  bloom.addColorStop(0, `rgba(${R},${G},${B},${(a * 0.5).toFixed(3)})`);
  bloom.addColorStop(1, `rgba(${R},${G},${B},0)`);
  ctx.fillStyle = bloom;
  ctx.fillRect(cx - br, cy - br, br * 2, br * 2);
  // Core — tight, hot; near-white center at full gain so it pops.
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  const wr = Math.round(R + (255 - R) * a * 0.6);
  const wg = Math.round(G + (255 - G) * a * 0.6);
  const wb = Math.round(B + (255 - B) * a * 0.6);
  core.addColorStop(0, `rgba(${wr},${wg},${wb},${a.toFixed(3)})`);
  core.addColorStop(0.55, `rgba(${R},${G},${B},${(a * 0.7).toFixed(3)})`);
  core.addColorStop(1, `rgba(${R},${G},${B},0)`);
  ctx.fillStyle = core;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/**
 * Light up the baked emergency lamps on an emergency vehicle. `ctx`
 * carries the world transform; (x,y,angle) is the pose; (len,wid) are the
 * DRAWN (buffered) sprite dims — fixture positions are fractions of these.
 * `gain` scales brightness: ~1 for the faint pre-tint pass, ~2+ for the
 * bright post-tint lift.
 *
 *  - kind 'cop': the two BLUE caps of the cruiser roof bar (blue only).
 *  - kind 'ambulance': the RED junction-band lamps + rear-face lamps (red
 *    only — the sprite has no baked blue).
 */
export function illuminateEmergencyLights(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  kind: EmergencyKind,
  gain = 1,
): void {
  const phase = Math.floor(Date.now() / 110) & 1; // ~4.5 Hz wig-wag
  const bright = Math.min(1, 0.9 * gain);
  const dim = Math.min(0.7, 0.16 * gain);
  const rgb = kind === 'cop' ? COP_BLUE : AMB_RED;
  const lamps: Lamp[] = kind === 'cop'
    ? [
      // Blue roof-bar caps at the cabin-roof edges, hair behind center.
      { x: -0.02 * len, y: -0.273 * wid, r: 0.15 * wid },
      { x: -0.02 * len, y: 0.273 * wid, r: 0.15 * wid },
    ]
    : [
      // Junction warning band (front group) — 4 red lamps across the box
      // roof, straddling the white center lamp.
      { x: 0.13 * len, y: -0.30 * wid, r: 0.11 * wid },
      { x: 0.13 * len, y: -0.11 * wid, r: 0.10 * wid },
      { x: 0.13 * len, y: 0.11 * wid, r: 0.10 * wid },
      { x: 0.13 * len, y: 0.30 * wid, r: 0.11 * wid },
      // Rear-face lamps (rear group) — the pair a follower sees.
      { x: -0.42 * len, y: -0.38 * wid, r: 0.11 * wid },
      { x: -0.42 * len, y: 0.38 * wid, r: 0.11 * wid },
    ];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  for (const lamp of lamps) {
    // Wig-wag by SIDE: driver (y<0) bright on phase 0, passenger on 1.
    const lit = (lamp.y < 0) === (phase === 0);
    glowBulb(ctx, lamp.x, lamp.y, lamp.r, rgb, lit ? bright : dim);
  }
  ctx.globalCompositeOperation = prevOp;
  ctx.restore();
}

/** H1191: an emergency light SOURCE — a vehicle whose strobes wash onto
 *  nearby car bodies. */
export interface EmergencySource {
  x: number;
  y: number;
  /** 'cop' pulses blue; 'red' pulses red (ambulance); 'brake' steady red. */
  mode: EmergencyMode;
  /** Reach in world px. */
  reach: number;
  /** H1197: forward unit heading of the braking car (mode 'brake' only).
   *  The wash then only reaches cars BEHIND the source (dot<0), so the
   *  braking car's own body and cars ahead never redden. */
  hx?: number;
  hy?: number;
}

/** The current pulsing wash color for an emergency source (RGB + 0..1
 *  intensity envelope), from wall-clock time so the wash syncs the strobe. */
function washColor(mode: EmergencyMode, now: number): { rgb: readonly [number, number, number]; env: number } {
  if (mode === 'brake') {
    // Brake lamps: STEADY deep red, dimmer than a strobe; no flash.
    return { rgb: BRAKE, env: 0.75 };
  }
  if (mode === 'red') {
    // Ambulance: a single red strobe, hard on/off. NC: red only.
    const env = Math.floor(now / 130) % 2 === 0 ? 1 : 0.3;
    return { rgb: AMB_RED, env };
  }
  // Cop: a BLUE strobe. NC: blue only (no red on a police car).
  const env = Math.floor(now / 130) % 2 === 0 ? 1 : 0.35;
  return { rgb: COP_BLUE, env };
}

/** H1191: wash one car body with any nearby emergency source's pulsing
 *  color. `ctx` carries the world transform; (x,y,angle) + len/wid are
 *  the body. Call AFTER the body sprite, alongside drawCarLighting. */
export function emergencyWash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  now: number,
  sources: readonly EmergencySource[] | null,
): void {
  if (!sources || sources.length === 0) return;
  const hl = len / 2, hw = wid / 2;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  // Strongest source hitting this car.
  let best = 0;
  let bestMode: EmergencyMode = 'cop';
  let bdx = 0, bdy = 0;
  for (const s of sources) {
    const dx = x - s.x, dy = y - s.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < 4 || d2 > s.reach * s.reach) continue; // self / out of reach
    // Brake: only wash cars BEHIND the braking car (dot<0). Excludes the
    // braking car's own body and any car in front of it.
    if (s.mode === 'brake' && s.hx !== undefined) {
      if (dx * s.hx + dy * (s.hy ?? 0) >= 0) continue;
    }
    const d = Math.sqrt(d2);
    const f = 1 - d / s.reach;
    if (f > best) { best = f; bestMode = s.mode; bdx = dx / d; bdy = dy / d; }
  }
  if (best <= 0.02) return;
  const { rgb, env } = washColor(bestMode, now);
  const a0 = Math.min(0.5, 0.5 * best * env);
  if (a0 < 0.02) return;
  // Incoming light direction in the car's local frame → gradient bright
  // on the flank facing the source, fading across the body.
  const lx = bdx * cosA + bdy * sinA;
  const ly = -bdx * sinA + bdy * cosA;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  traceBodyRoundRect(ctx, hl, hw); ctx.clip(); // H1193: follow the body shape
  const g = ctx.createLinearGradient(-lx * hl, -ly * hw, lx * hl, ly * hw);
  g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a0.toFixed(3)})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(a0 * 0.2).toFixed(3)})`);
  ctx.fillStyle = g;
  ctx.fillRect(-hl + 0.5, -hw + 0.5, len - 1, wid - 1);
  ctx.restore();
}
