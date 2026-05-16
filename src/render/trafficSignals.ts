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
 */

import type { RoadCrossing } from '@/world/roadCrossings';
import {
  getSignalStates,
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

/** Paint the cone + bulb for one approach axis at one crossing. The
 *  cone projects from the bulb position outward along `axisAngle +
 *  Math.PI` (i.e. back toward the incoming traffic on that approach
 *  direction). */
function paintOneCone(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  axisAngle: number,
  state: SignalState,
  nightIntensity: number,
): void {
  const rgb = SIGNAL_COLORS[state];
  // The bulb's bloom alpha scales with night so daytime is subtle.
  // 0.25 day → 0.85 midnight gives a clear-day-readable hint that
  // grows into a vivid glow as it gets darker.
  const bloomA = 0.25 + 0.6 * nightIntensity;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(axisAngle + Math.PI);    // cone faces back toward inbound traffic
  // Cone shape: triangle with rounded tip via quadraticCurve, filled
  // with a radial gradient so it fades to zero at the far edge.
  const cosA = Math.cos(CONE_HALF_ANGLE);
  const sinA = Math.sin(CONE_HALF_ANGLE);
  const leftX = CONE_REACH * cosA;
  const leftY = -CONE_REACH * sinA;
  const rightX = leftX;
  const rightY = -leftY;
  const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, CONE_REACH);
  grad.addColorStop(0, `rgba(${rgb}, ${0.5 * bloomA})`);
  grad.addColorStop(0.55, `rgba(${rgb}, ${0.22 * bloomA})`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(leftX, leftY);
  ctx.quadraticCurveTo(CONE_REACH * 1.05, 0, rightX, rightY);
  ctx.closePath();
  ctx.fill();
  // Bulb: crisp center dot, always visible. Saturated rgb at full
  // alpha + a slight inner-brightening so it reads as "lit".
  ctx.fillStyle = `rgba(${rgb}, 1)`;
  ctx.beginPath();
  ctx.arc(0, 0, BULB_R, 0, Math.PI * 2);
  ctx.fill();
  // Outer halo (always-on small bloom around the bulb so it reads as
  // emissive, not painted). Half the cone reach, soft alpha.
  const haloGrad = ctx.createRadialGradient(0, 0, BULB_R, 0, 0, BULB_R * 3);
  haloGrad.addColorStop(0, `rgba(${rgb}, ${0.6 * bloomA})`);
  haloGrad.addColorStop(1, `rgba(${rgb}, 0)`);
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(0, 0, BULB_R * 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Per-frame entry point. Iterates all ROAD_CROSSINGS, paints each
 *  crossing's 4 cones (2 per axis × 2 directions) when within the
 *  cull radius of `centerX, centerY` (the player's world position).
 *  Call this AFTER the road surface paint and BEFORE drawTraffic so
 *  the cones sit on top of the asphalt but under the car bodies. */
export function drawTrafficSignals(
  ctx: CanvasRenderingContext2D,
  crossings: readonly RoadCrossing[],
  centerX: number,
  centerY: number,
  nightIntensity: number,
): void {
  const nowMs = Date.now();
  const states = getSignalStates(nowMs);
  for (const c of crossings) {
    const dx = c.x - centerX;
    const dy = c.y - centerY;
    if (dx * dx + dy * dy > CULL_R2) continue;
    // 4 cones per crossing: 2 axes × 2 directions each. Each cone
    // points back toward where cars on that approach come from, so
    // an incoming driver sees the light ahead of them.
    paintOneCone(ctx, c.x, c.y, c.ang1,            states.ang1, nightIntensity);
    paintOneCone(ctx, c.x, c.y, c.ang1 + Math.PI,  states.ang1, nightIntensity);
    paintOneCone(ctx, c.x, c.y, c.ang2,            states.ang2, nightIntensity);
    paintOneCone(ctx, c.x, c.y, c.ang2 + Math.PI,  states.ang2, nightIntensity);
  }
}
