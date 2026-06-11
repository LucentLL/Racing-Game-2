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

/** H60 — pre-baked glow sprite for streetlights, recolored once per
 *  intensity bucket. Far cheaper than calling createRadialGradient
 *  per-lamp every frame (the user reported a 20fps slowdown at night
 *  before this commit). */
let glowSprite: HTMLCanvasElement | null = null;
let glowSpriteIntensity = -1;

function ensureGlowSprite(intensity: number): HTMLCanvasElement | null {
  // Bucket intensity at 5% so we don't rebuild every dawn/dusk frame.
  const bucket = Math.round(intensity * 20) / 20;
  if (glowSprite && glowSpriteIntensity === bucket) return glowSprite;
  const size = GLOW_R * 2;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d');
  if (!cx) return null;
  const peak = 0.40 * bucket;
  const grad = cx.createRadialGradient(GLOW_R, GLOW_R, 0, GLOW_R, GLOW_R, GLOW_R);
  grad.addColorStop(0.00, `rgba(255, 220, 130, ${peak})`);
  grad.addColorStop(0.35, `rgba(255, 200, 100, ${peak * 0.45})`);
  grad.addColorStop(1.00, 'rgba(255, 200, 100, 0)');
  cx.fillStyle = grad;
  cx.fillRect(0, 0, size, size);
  glowSprite = c;
  glowSpriteIntensity = bucket;
  return glowSprite;
}

/** Paint each visible streetlight's warm glow. nightIntensity is the
 *  0..1 alpha multiplier — 0 (day) skips the entire pass. */
export function drawStreetlights(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  nightIntensity: number,
  /** H792: viewport-derived cull radius (world px). The 900-px module
   *  default draws ~27× the visible area on the current camera —
   *  callers should pass the per-frame viewport radius. */
  cullR?: number,
): void {
  if (nightIntensity <= 0.02) return;
  const sprite = ensureGlowSprite(nightIntensity);
  if (!sprite) return;
  const r2 = cullR !== undefined ? cullR * cullR : CULL_R2;
  for (const lt of lights) {
    const dx = lt.x - centerX;
    const dy = lt.y - centerY;
    if (dx * dx + dy * dy > r2) continue;
    ctx.drawImage(sprite, lt.x - GLOW_R, lt.y - GLOW_R);
  }
  // Hot bulb pixel — single fillRect each, very cheap. Painted after
  // the glow pass so the bulb reads on top of its own halo.
  ctx.fillStyle = `rgba(255, 240, 180, ${0.9 * nightIntensity})`;
  for (const lt of lights) {
    const dx = lt.x - centerX;
    const dy = lt.y - centerY;
    if (dx * dx + dy * dy > r2) continue;
    ctx.fillRect(lt.x - 0.5, lt.y - 0.5, 1.5, 1.5);
  }
}
