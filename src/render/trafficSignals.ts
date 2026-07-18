/**
 * H114 — visual rendering of traffic-signal state at each ROAD_CROSSING.
 *
 * Per crossing, paints up to 4 small colored light cones — one for
 * each of the two approach axes (ang1, ang2), projecting in BOTH
 * directions along that axis so cars approaching from either side
 * see their signal. Cone color reflects the axis's current state
 * (green / yellow / red) per shared phase logic in
 * world/trafficSignals.ts.
 *
 * Cones are short (≈18 world-px reach) so they read as "lights at
 * the intersection" rather than headlight beams. Alpha scales with
 * nightIntensity so daytime intersections show a subtle hint and
 * midnight intersections light up the pavement vividly. A crisp
 * bright spot at the cone apex (the bulb itself) is always visible
 * day and night so the driver can tell signal state at a glance.
 *
 * H653 — performance: the cone + bulb + halo are pre-baked into a
 * sprite canvas per (state, bloomA bucket). Was building 2 radial
 * gradients + 1 path + 3 fills per cone × 4 cones per crossing × 5-10
 * visible crossings = 40-80 gradient creates per frame. Now each cone
 * is a single drawImage from the cached sprite. Mirrors streetlights.ts
 * H60 ensureGlowSprite pattern. Sprite cache is keyed on color + a
 * 0.05-bucketed bloomA so dawn/dusk re-bakes ~1-2 times per second
 * instead of 80 per frame.
 */

import { type RoadCrossing, isBendCrossing } from '@/world/roadCrossings';
import {
  getSignalStatesFor,
  type SignalState,
} from '@/world/trafficSignals';

/** Cone reach in world-px — how far the colored wash projects. */
const CONE_REACH = 18;
/** Half-angle of the cone's spread, radians. */
const CONE_HALF_ANGLE = 0.38;
/** Bulb radius (crisp center dot, always visible). */
const BULB_R = 2;
/** Distance² cull around the player so off-screen crossings skip the
 *  paint. ROAD_CROSSINGS can be 100+ entries; we only see ~5-10 at
 *  most on screen at once. */
const CULL_R2 = 600 * 600;

/** rgba color triple per signal state. */
const SIGNAL_COLORS: Record<SignalState, string> = {
  green:  '60, 230, 100',
  yellow: '255, 200, 50',
  red:    '255, 60, 50',
};

/** H653 sprite layout. The cone extends along +X from (0,0) bulb to
 *  (CONE_REACH, 0) tip. Sprite covers X ∈ [-bulbHalo, CONE_REACH+pad],
 *  Y ∈ [-spriteHalfH, +spriteHalfH]. We bake at canvas pixel scale
 *  (no oversample — modular renders at internal canvas dims and the
 *  CSS stretch handles display upscale anyway). */
const SPRITE_BULB_HALO = Math.max(BULB_R * 3 + 2, 8);
const SPRITE_PAD = 2;
const SPRITE_W = CONE_REACH + SPRITE_BULB_HALO + SPRITE_PAD;
const SPRITE_H = Math.ceil(Math.sin(CONE_HALF_ANGLE) * CONE_REACH * 2 + SPRITE_BULB_HALO * 2);
const SPRITE_BULB_X = SPRITE_BULB_HALO;
const SPRITE_BULB_Y = Math.floor(SPRITE_H / 2);

const spriteCache = new Map<string, HTMLCanvasElement>();

function bakeSprite(state: SignalState, bloomA: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const rgb = SIGNAL_COLORS[state];
  const c = document.createElement('canvas');
  c.width = SPRITE_W;
  c.height = SPRITE_H;
  const cx = c.getContext('2d');
  if (!cx) return null;
  // Cone, drawn at the bulb origin pointing along +X.
  cx.translate(SPRITE_BULB_X, SPRITE_BULB_Y);
  const cosA = Math.cos(CONE_HALF_ANGLE);
  const sinA = Math.sin(CONE_HALF_ANGLE);
  const leftX = CONE_REACH * cosA;
  const leftY = -CONE_REACH * sinA;
  const rightX = leftX;
  const rightY = -leftY;
  const coneGrad = cx.createRadialGradient(0, 0, 0, 0, 0, CONE_REACH);
  coneGrad.addColorStop(0, `rgba(${rgb}, ${0.5 * bloomA})`);
  coneGrad.addColorStop(0.55, `rgba(${rgb}, ${0.22 * bloomA})`);
  coneGrad.addColorStop(1, `rgba(${rgb}, 0)`);
  cx.fillStyle = coneGrad;
  cx.beginPath();
  cx.moveTo(0, 0);
  cx.lineTo(leftX, leftY);
  cx.quadraticCurveTo(CONE_REACH * 1.05, 0, rightX, rightY);
  cx.closePath();
  cx.fill();
  // Halo — soft bloom around the bulb.
  const haloGrad = cx.createRadialGradient(0, 0, BULB_R, 0, 0, BULB_R * 3);
  haloGrad.addColorStop(0, `rgba(${rgb}, ${0.6 * bloomA})`);
  haloGrad.addColorStop(1, `rgba(${rgb}, 0)`);
  cx.fillStyle = haloGrad;
  cx.beginPath();
  cx.arc(0, 0, BULB_R * 3, 0, Math.PI * 2);
  cx.fill();
  // Bulb dot — crisp center, always full alpha.
  cx.fillStyle = `rgba(${rgb}, 1)`;
  cx.beginPath();
  cx.arc(0, 0, BULB_R, 0, Math.PI * 2);
  cx.fill();
  return c;
}

function ensureSprite(state: SignalState, bloomA: number): HTMLCanvasElement | null {
  const bucket = Math.round(bloomA * 20) / 20; // 0.05-bucket
  const key = state + '|' + bucket;
  let s = spriteCache.get(key);
  if (s) return s;
  const baked = bakeSprite(state, bucket);
  if (!baked) return null;
  spriteCache.set(key, baked);
  return baked;
}

function paintOneCone(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  axisAngle: number,
  sprite: HTMLCanvasElement,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(axisAngle + Math.PI); // cone faces back toward inbound traffic
  ctx.drawImage(sprite, -SPRITE_BULB_X, -SPRITE_BULB_Y);
  ctx.restore();
}

/** Per-frame entry point. Iterates all ROAD_CROSSINGS, paints each
 *  crossing's 4 cones (2 per axis × 2 directions) when within the
 *  cull radius of `centerX, centerY` (the player's world position).
 *  Call this AFTER the road surface paint and BEFORE drawTraffic so
 *  the cones sit on top of the asphalt but under the car bodies.
 *
 *  H653: gradient build cost is amortized via the sprite cache —
 *  ensureSprite returns the cached canvas for the current (state,
 *  bloomA) bucket; per-cone cost is one drawImage + save/translate/
 *  rotate/restore. */
export function drawTrafficSignals(
  ctx: CanvasRenderingContext2D,
  crossings: readonly RoadCrossing[],
  centerX: number,
  centerY: number,
  nightIntensity: number,
  /** H792: viewport-derived cull radius (world px); defaults to the
   *  600-px module constant (≈12× the visible area). */
  cullR?: number,
): void {
  const _cullR2 = cullR !== undefined ? cullR * cullR : CULL_R2;
  const nowMs = Date.now();
  // Bloom alpha — 0.25 day → 0.85 midnight. Same curve as the
  // original per-cone paint (bloomA at L59).
  const bloomA = 0.25 + 0.6 * nightIntensity;
  // Pre-resolve sprites for all 3 possible states; cheap lookups.
  const greenS = ensureSprite('green', bloomA);
  const yellowS = ensureSprite('yellow', bloomA);
  const redS = ensureSprite('red', bloomA);
  if (!greenS || !yellowS || !redS) return;
  const spriteByState: Record<SignalState, HTMLCanvasElement> = {
    green: greenS, yellow: yellowS, red: redS,
  };
  for (const c of crossings) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > _cullR2) continue;
    // H288: skip BRIDGE OVERLAPS — no signal head exists mid-air where
    // one road is elevated above another. Matches the same skip in
    // drawCrosswalks and the monolith's L31624 bridge-crossing gate.
    if (c.z1 > 1 || c.z2 > 1) continue;
    // H1043: only SIGNAL-controlled crossings show cones. control===4 =
    // signal; undefined = the legacy auto default (still a signal); any other
    // authored control (uncontrolled/yield/stop) shows NO light.
    if (c.control !== undefined && c.control !== 4) continue;
    // H776: skip crossings involving a major road — highways don't get a
    // surface signal head. H1043: an EXPLICITLY authored control overrides this
    // heuristic (the user asked for a signal there), so only auto (undefined)
    // crossings honor the major skip.
    if (c.control === undefined && (c.maj1 || c.maj2)) continue;
    // H1183: a ≤2-leg crossing is a BEND, not a junction — no signal at
    // all (same gate as the crosswalk painter). Undefined legs (old /
    // non-baseline data) count as a full 4-way, so no default regression.
    if (isBendCrossing(c)) continue;
    // H1043: per-crossing phase so authored signals desync.
    const states = getSignalStatesFor(c, nowMs);
    const s1 = spriteByState[states.ang1];
    const s2 = spriteByState[states.ang2];
    // 4 cones per crossing: 2 axes × 2 directions each. Each cone points
    // back toward where cars on that approach come from, so an incoming
    // driver sees the light ahead of them. H1183: a cone only paints on
    // a leg that physically exists — at a tee the missing leg's cone
    // used to hang in the grass. legs = [r1 fwd(+ang1), r1 back(−ang1),
    // r2 fwd(+ang2), r2 back(−ang2)]; a cone rotated to `axisAngle` casts
    // its light along axisAngle+π (back toward inbound traffic), so the
    // `ang1` cone washes the −ang1 leg (legs[1]), `ang1+π` washes +ang1
    // (legs[0]), etc. — the same side↔leg map the crosswalk bands use.
    const legs = c.legs;
    if (!legs || legs[1]) paintOneCone(ctx, c.x, c.y, c.ang1,           s1);
    if (!legs || legs[0]) paintOneCone(ctx, c.x, c.y, c.ang1 + Math.PI, s1);
    if (!legs || legs[3]) paintOneCone(ctx, c.x, c.y, c.ang2,           s2);
    if (!legs || legs[2]) paintOneCone(ctx, c.x, c.y, c.ang2 + Math.PI, s2);
  }
}
