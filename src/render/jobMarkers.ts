/**
 * In-world job pickup/delivery markers.
 *
 * When life.job is active and not picked up: paints a blinking
 * green circle + 'A' label at (fromX, fromY). After pickup, paints
 * a blinking yellow circle + 'B' label at (toX, toY). Both gated
 * on player-within-render-distance (TILE*80) so they don't burn
 * cycles when far away.
 *
 * 1:1 port of monolith L32725-32785 mainline branch. Special-case
 * job types (TOW TRUCK, TRUCK DRIVER, FUEL TANKER) draw additional
 * pickup-side art (broken car silhouette, waiting trailer) — those
 * port with the matching arrival branches in jobArrival.ts.
 *
 * Caller invokes inside the world camera transform — coords passed
 * are world-space (px/py and the marker positions). Text rotates
 * with the camera heading (1:1 with monolith — no de-rotate).
 */

import type { LifeState } from '@/state/life';
import { TILE } from '@/config/world/tiles';

/** Render-cull radius — only paint when within this distance of the
 *  player. 1:1 with monolith L32727 / L32775. */
const MARKER_RENDER_RADIUS_PX = TILE * 80;

/** Marker circle radius in world units. Monolith L32729 / L32777. */
const MARKER_CIRCLE_R = TILE * 1.2;

export function drawJobMarkers(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  px: number,
  py: number,
): void {
  const job = life.job;
  if (!job) return;
  // Special-case branches paint their own pickup art (towJob's
  // broken car, trailer silhouettes for TRUCK / FUEL TANKER) and
  // need state we haven't ported. Mainline-only for H203.
  if (
    job.type === 'TOW TRUCK'
    || job.type === 'TRUCK DRIVER'
    || job.type === 'FUEL TANKER'
  ) return;

  // Blink at ~3 Hz so the marker draws the eye. 1:1 with monolith
  // L32328 (same Date.now()*0.006 cadence used for carPins).
  const blink = Math.sin(Date.now() * 0.006) > 0;

  if (!job.pickedUp && job.fromX != null && job.fromY != null) {
    const ax = job.fromX;
    const ay = job.fromY;
    const dx = px - ax;
    const dy = py - ay;
    if (dx * dx + dy * dy < MARKER_RENDER_RADIUS_PX * MARKER_RENDER_RADIUS_PX) {
      // Green pickup ring. Alpha bumps with the blink phase.
      ctx.fillStyle = blink ? 'rgba(0, 255, 0, 0.8)' : 'rgba(0, 255, 0, 0.3)';
      ctx.beginPath();
      ctx.arc(ax, ay, MARKER_CIRCLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + (TILE * 0.9) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('A', ax, ay + TILE * 0.35);
      ctx.textAlign = 'left';
    }
    return;
  }

  if (job.pickedUp && job.toX != null && job.toY != null) {
    const bx = job.toX;
    const by = job.toY;
    const dx = px - bx;
    const dy = py - by;
    if (dx * dx + dy * dy < MARKER_RENDER_RADIUS_PX * MARKER_RENDER_RADIUS_PX) {
      // Yellow delivery ring. 1:1 with monolith L32776.
      ctx.fillStyle = blink ? 'rgba(255, 255, 0, 0.8)' : 'rgba(255, 255, 0, 0.3)';
      ctx.beginPath();
      ctx.arc(bx, by, MARKER_CIRCLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + (TILE * 0.9) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('B', bx, by + TILE * 0.35);
      ctx.textAlign = 'left';
    }
  }
}
