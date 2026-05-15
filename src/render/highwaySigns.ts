/**
 * H49 — highway exit signs + interstate shields.
 *
 * Two visible elements:
 *   - Green exit signs at each EXIT_MARKERS entry — "EXIT 23" in
 *     yellow + "Connector" in white on a green plaque, with a tiny
 *     green dot on the road at the ramp position.
 *   - Blue interstate shields at ~25% / 50% / 75% along any baseline
 *     road whose name starts with "I-". White-outlined diamond-ish
 *     blue badge with a red header and the route number ("485", "77",
 *     etc.) underneath.
 *
 * Caller has applied the camera transform.
 *
 * Both pieces are viewport-culled by distance — the loop walks the
 * full marker / road lists but early-exits on distance² so the cost
 * is bounded.
 *
 * Ported from monolith render() L30400-30447 in simplified form.
 *
 * Deferred:
 *   - Shield rotation to match road tangent — monolith draws shields
 *     axis-aligned regardless of road heading, so this matches.
 *   - Per-shield text scaling for long names — we letter-fit the
 *     route number directly from the road name suffix.
 *   - Direction arrows on exit signs (the monolith doesn't have
 *     these either, but they'd be a nice addition).
 */

import { TILE } from '@/config/world/tiles';
import { BASELINE_ROADS } from '@/config/world/baselineRoads';
import { EXIT_MARKERS } from '@/config/world/exitMarkers';

/** Distance² beyond which a sign is skipped. Generous since signs are
 *  small and need to read at long range so drivers can see "next exit
 *  in X miles" feel even at the edge of the visible viewport. */
const SIGN_CULL_R2 = 1200 * 1200;
const SHIELD_CULL_R2 = 900 * 900;

/** Paints the green EXIT N + name plaque for each marker within
 *  cull range, plus a 2px green dot at the ramp position. */
export function drawExitSigns(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
): void {
  ctx.textAlign = 'center';
  for (const e of EXIT_MARKERS) {
    const dx = e.wx - centerX;
    const dy = e.wy - centerY;
    if (dx * dx + dy * dy > SIGN_CULL_R2) continue;
    const sx = e.wx;
    const sy = e.wy;
    const signW = Math.max(e.name.length * 3.5 + 12, 30);

    // Green plaque.
    ctx.fillStyle = '#060';
    ctx.fillRect(sx - signW / 2, sy - 16, signW, 13);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(sx - signW / 2, sy - 16, signW, 13);

    // "EXIT NN" yellow header.
    ctx.fillStyle = '#ff0';
    ctx.font = 'bold 4px monospace';
    ctx.fillText(`EXIT ${e.num}`, sx, sy - 10);

    // Street name in white below.
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 5px monospace';
    ctx.fillText(e.name, sx, sy - 5);

    // Small green ramp dot on the road.
    ctx.fillStyle = '#0f0';
    ctx.beginPath();
    ctx.arc(sx, sy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.textAlign = 'left';
}

/** Paints interstate shield badges at quarter / half / three-quarter
 *  points along every baseline road whose name starts with "I-". */
export function drawInterstateShields(
  ctx: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
): void {
  ctx.textAlign = 'center';
  for (const row of BASELINE_ROADS) {
    const name = row[2];
    if (!name.startsWith('I-')) continue;
    // Reconstruct the per-vertex points from the flat row.
    const ptsFlat = row.slice(4) as readonly number[];
    const vertexCount = Math.floor(ptsFlat.length / 2);
    if (vertexCount < 3) continue;

    const positions = [
      Math.floor(vertexCount / 4),
      Math.floor(vertexCount / 2),
      Math.floor((vertexCount * 3) / 4),
    ];
    for (const mi of positions) {
      if (mi >= vertexCount) continue;
      const mx = ptsFlat[mi * 2] * TILE + TILE / 2;
      const my = ptsFlat[mi * 2 + 1] * TILE + TILE / 2;
      const dx = mx - centerX;
      const dy = my - centerY;
      if (dx * dx + dy * dy > SHIELD_CULL_R2) continue;

      // Blue shield body — hex-ish vertical capsule.
      ctx.fillStyle = '#00c';
      ctx.beginPath();
      ctx.moveTo(mx - 7, my - 5);
      ctx.lineTo(mx + 7, my - 5);
      ctx.lineTo(mx + 8, my - 2);
      ctx.lineTo(mx + 6, my + 4);
      ctx.lineTo(mx,     my + 6);
      ctx.lineTo(mx - 6, my + 4);
      ctx.lineTo(mx - 8, my - 2);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Red header band.
      ctx.fillStyle = '#c00';
      ctx.fillRect(mx - 6, my - 5, 12, 3);

      // Route number — strip "I-" prefix and any suffix (e.g. "I-77 N" → "77").
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 5px monospace';
      const routeNum = name.replace('I-', '').split(' ')[0];
      ctx.fillText(routeNum, mx, my + 3);
    }
  }
  ctx.textAlign = 'left';
}
