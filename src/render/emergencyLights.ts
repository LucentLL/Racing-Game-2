/**
 * H1190–H1196 — shared emergency-vehicle lighting.
 *
 * `illuminateEmergencyLights` does NOT draw a light bar. Emergency
 * vehicles in this game already have their light fixtures BAKED into the
 * sprite art (the Crown-Vic cruiser's blue roof bar; the ambulance's red
 * corner/cab beacons). This adds only additive ('lighter') radial-gradient
 * glows ON TOP of those existing pixels so they read as switched-ON lamps
 * — the same principle as a braking car's tail lights lighting up. No dark
 * housing, no stickered-on rectangle (user H1196: "there are already lights
 * on the outside of the sprite... illuminate the lights of the car sprites,
 * not added light bars").
 *
 * NC color law (user H1196): a police car flashes BLUE ONLY (no red); an
 * ambulance flashes RED ONLY (no blue).
 *
 * `emergencyWash` tints a nearby car BODY with the pulsing emergency color
 * (the light reflecting off other cars). Cop = blue; ambulance = red;
 * braking car = steady deep red. Works day and night, with a directional
 * gradient brighter on the flank facing the emergency vehicle, clipped to
 * the rounded body so it follows the sprite instead of its bounding box.
 */

import { traceBodyRoundRect } from './carLighting';

/** RGB triples. COP_BLUE / AMB_RED match the baked sprite lamp hues so the
 *  additive glow reads as those pixels lighting up. */
const COP_BLUE: readonly [number, number, number] = [80, 150, 255];
const AMB_RED: readonly [number, number, number] = [255, 60, 45];
const BRAKE: readonly [number, number, number] = [255, 30, 20];

/** 'cop' = blue-only police strobe; 'red' = ambulance red strobe; 'brake'
 *  = steady deep-red tail lamp. */
export type EmergencyMode = 'cop' | 'red' | 'brake';

/** Which set of baked fixtures to light up. */
export type EmergencyKind = 'cop' | 'ambulance';

/** One additive radial glow (soft falloff halo, no hard square). */
function glowBulb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  rgb: readonly [number, number, number],
  a: number,
): void {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a.toFixed(3)})`);
  g.addColorStop(0.5, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(a * 0.55).toFixed(3)})`);
  g.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
}

/**
 * Light up the baked emergency lamps on an emergency vehicle. `ctx` carries
 * the world transform; (x,y,angle) is the car pose; (len,wid) are the
 * car's DRAWN (buffered) sprite dimensions in world px — fixture positions
 * are fractions of these so they track any draw scale.
 *
 *  - kind 'cop': the two BLUE bulbs flanking the gray center of the cruiser
 *    roof bar (Ford-Crown-Vic-{CMPD,ST}.png), wig-wagging driver↔passenger.
 *  - kind 'ambulance': the RED beacons at the box rear corners and the
 *    cab-front corners, rear pair and front pair alternating.
 */
export function illuminateEmergencyLights(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  len: number,
  wid: number,
  kind: EmergencyKind,
): void {
  const phase = Math.floor(Date.now() / 100) & 1; // ~5 Hz wig-wag toggle
  const BRIGHT = 0.85, DIM = 0.12;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  if (kind === 'cop') {
    // Blue roof-bar caps — sit at the cabin-roof lateral edges, a hair
    // behind length-center (matches the baked blue bar on the cruiser
    // sprite: centroid ≈ -0.037·L, blue lamps ≈ ±0.277·W). NC: blue only.
    const barX = -0.02 * len;
    const latY = 0.273 * wid;
    const r = 0.137 * wid;
    glowBulb(ctx, barX, -latY, r, COP_BLUE, phase === 0 ? BRIGHT : DIM);
    glowBulb(ctx, barX, latY, r, COP_BLUE, phase === 1 ? BRIGHT : DIM);
  } else {
    // Ambulance red lamps baked into the sprite (NO blue is baked
    // anywhere on it — pixel-confirmed): the box/cab junction warning
    // band (the one real lamp cluster, red lamps flanking a white center
    // at +0.13·L, ±0.38·W) + the rear-face red lamps a following car
    // sees. Junction pair on phase 0, rear pair on phase 1 so it cycles.
    // NC: red only.
    const r = 0.10 * wid;
    const bandX = 0.13 * len, bandY = 0.28 * wid;
    const rearX = -0.42 * len, rearY = 0.38 * wid;
    glowBulb(ctx, bandX, -bandY, r, AMB_RED, phase === 0 ? BRIGHT : DIM);
    glowBulb(ctx, bandX, bandY, r, AMB_RED, phase === 0 ? BRIGHT : DIM);
    glowBulb(ctx, rearX, -rearY, r, AMB_RED, phase === 1 ? BRIGHT : DIM);
    glowBulb(ctx, rearX, rearY, r, AMB_RED, phase === 1 ? BRIGHT : DIM);
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
}

/** The current pulsing wash color for an emergency source (RGB + 0..1
 *  intensity envelope), from wall-clock time so the wash syncs with the
 *  strobe. */
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
