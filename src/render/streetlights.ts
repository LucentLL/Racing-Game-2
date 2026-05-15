/**
 * H51 — night streetlight glow.
 *
 * Pre-computes streetlight world positions at module init: walks every
 * major road's vertex list, places a light every STEP world-px along
 * the polyline, offset perpendicular by HALF_W + EDGE_OFFSET so the
 * light sits in the curb area. Computed once; rendered every frame
 * when nightIntensity > 0.
 *
 * Per-light render is a small radial gradient (warm yellow → 0 alpha)
 * with alpha scaled by nightIntensity, so dusk → midnight ramp in
 * lockstep with the day/night tint.
 *
 * Pure render-side feature: no collision, no AI interaction, no
 * gameplay coupling. Matches the monolith's streetlight pass which
 * sits in the after-roads / before-traffic phase.
 *
 * Memory: ~200-400 lights total across the 130-road network.
 * Per-frame: distance²-cull around player, ~20-30 lights visible at
 * 2.2× zoom, one radial gradient draw each = trivial.
 */

import { TILE } from '@/config/world/tiles';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';

interface Streetlight {
  x: number;
  y: number;
}

/** Distance between lights along a road (world px). 20 tiles ≈ city
 *  block spacing. */
const STEP = 20 * TILE;
/** Extra clearance past the road edge so the light bulb reads as
 *  curbside rather than mid-road. */
const EDGE_OFFSET = 2;
/** Cull radius for per-frame render (world px²). */
const CULL_R2 = 900 * 900;
/** Glow radius for the radial gradient. */
const GLOW_R = 60;

const lights: Streetlight[] = buildLights();

function buildLights(): Streetlight[] {
  const out: Streetlight[] = [];
  for (const row of BASELINE_ROADS) {
    const width = row[0];
    const isMajor = row[1];
    if (isMajor !== 1) continue; // streetlights on majors only
    const halfW = width * TILE * 0.5;
    const ptsFlat = row.slice(4) as readonly number[];
    let distSinceLast = STEP; // start placed so first vertex gets a light
    for (let i = 0; i + 3 < ptsFlat.length; i += 2) {
      const ax = (ptsFlat[i]    as number) * TILE + TILE / 2;
      const ay = (ptsFlat[i + 1] as number) * TILE + TILE / 2;
      const bx = (ptsFlat[i + 2] as number) * TILE + TILE / 2;
      const by = (ptsFlat[i + 3] as number) * TILE + TILE / 2;
      const dx = bx - ax;
      const dy = by - ay;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen < 0.5) continue;
      const dirX = dx / segLen;
      const dirY = dy / segLen;
      // Perpendicular (left side of segment).
      const pX = -dirY;
      const pY =  dirX;
      // Walk along the segment in STEP increments.
      let t = STEP - distSinceLast;
      while (t < segLen) {
        const cx = ax + dirX * t;
        const cy = ay + dirY * t;
        // Place a pair of lights — one on each curb.
        out.push({ x: cx + pX * (halfW + EDGE_OFFSET), y: cy + pY * (halfW + EDGE_OFFSET) });
        out.push({ x: cx - pX * (halfW + EDGE_OFFSET), y: cy - pY * (halfW + EDGE_OFFSET) });
        t += STEP;
      }
      distSinceLast = segLen - (t - STEP);
    }
  }
  return out;
}

/** Paint each visible streetlight's warm glow. nightIntensity is the
 *  0..1 alpha multiplier — 0 (day) skips the entire pass. */
export function drawStreetlights(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  nightIntensity: number,
): void {
  if (nightIntensity <= 0.02) return;
  const peak = 0.40 * nightIntensity;
  for (const lt of lights) {
    const dx = lt.x - centerX;
    const dy = lt.y - centerY;
    if (dx * dx + dy * dy > CULL_R2) continue;
    const grad = ctx.createRadialGradient(lt.x, lt.y, 0, lt.x, lt.y, GLOW_R);
    grad.addColorStop(0.00, `rgba(255, 220, 130, ${peak})`);
    grad.addColorStop(0.35, `rgba(255, 200, 100, ${peak * 0.45})`);
    grad.addColorStop(1.00, 'rgba(255, 200, 100, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(lt.x - GLOW_R, lt.y - GLOW_R, GLOW_R * 2, GLOW_R * 2);
    // 1-px hot center so the lamppost bulb itself reads.
    ctx.fillStyle = `rgba(255, 240, 180, ${0.9 * nightIntensity})`;
    ctx.fillRect(lt.x - 0.5, lt.y - 0.5, 1.5, 1.5);
  }
}
