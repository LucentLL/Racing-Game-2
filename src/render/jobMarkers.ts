/**
 * In-world job pickup/delivery markers.
 *
 * When life.job is active and not picked up: paints a blinking
 * green circle + 'A' label at (fromX, fromY). After pickup, paints
 * a blinking yellow circle + 'B' label at (toX, toY). Both gated
 * on player-within-render-distance (TILE*80) so they don't burn
 * cycles when far away.
 *
 * 1:1 port of monolith L32725-32785 mainline branch. TRUCK DRIVER
 * (H897) + FUEL TANKER (H1128) flow through the same green-A /
 * yellow-B rings as the mainline jobs plus a waiting-trailer
 * silhouette at the pickup point (L32742-32755 — box with ribs /
 * plain tanker shell). TOW TRUCK (H1129): standard A ring (gameLoop
 * layers the broken car + ⚠ on top), then a teal towJob.dest ring
 * with the pay label once hooked (L32764-32772).
 *
 * Caller invokes inside the world camera transform — coords passed
 * are world-space (px/py and the marker positions). Text rotates
 * with the camera heading (1:1 with monolith — no de-rotate).
 */

import type { LifeState } from '@/state/life';
import { TILE } from '@/config/world/tiles';
import { nearestRoadAngleAt } from '@/render/worldMap';

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
  // TRAFFIC COP (H1126) is patrol-only — no A/B at all. TRUCK DRIVER
  // + FUEL TANKER (H1128) render the standard A/B rings below plus a
  // waiting-trailer silhouette at A (H898 box / H1128 tanker).
  // TOW TRUCK (H1129) renders the standard A ring (gameLoop paints
  // the broken car + ⚠ over it) and a special hooked-destination
  // ring instead of the yellow B (the drop may be the player's home
  // junkyard, not the job's B point — read towJob.destX/Y).
  if (job.type === 'TRAFFIC COP') return;

  // H1129: hooked tow load — teal destination ring + pay label. 1:1
  // with monolith L32764-32772 (rgba(0,255,180) ring, TILE*1.4,
  // '$pay' text).
  if (job.type === 'TOW TRUCK' && job.pickedUp) {
    const tj = life.towJob;
    if (!tj || !tj.hooked) return;
    const dx2 = px - tj.destX;
    const dy2 = py - tj.destY;
    if (dx2 * dx2 + dy2 * dy2 < MARKER_RENDER_RADIUS_PX * MARKER_RENDER_RADIUS_PX) {
      const blink2 = Math.sin(Date.now() * 0.006) > 0;
      ctx.fillStyle = blink2 ? 'rgba(0, 255, 180, 0.8)' : 'rgba(0, 255, 180, 0.3)';
      ctx.beginPath();
      ctx.arc(tj.destX, tj.destY, TILE * 1.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold ' + (TILE * 0.7) + 'px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('$' + tj.pay, tj.destX, tj.destY + TILE * 0.3);
      ctx.textAlign = 'left';
    }
    return;
  }

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
      // H898: waiting trailer parked at the pickup, laid along the
      // road so it reads as a real trailer to hook. 1:1 with monolith
      // L32742-32755 (truck/tanker silhouette arms) — box gets rib
      // lines, tanker (H1128) is the plain darker shell.
      if (job.type === 'TRUCK DRIVER' || job.type === 'FUEL TANKER') {
        const isTankerPU = job.type === 'FUEL TANKER';
        const ang = nearestRoadAngleAt(ax, ay) ?? 0;
        // H898b: match the hooked-trailer dims so the waiting
        // silhouette reads the same as what you haul away
        // (box 73×17, tanker 58×16).
        const tpL = isTankerPU ? 58 : 73;
        const tpW = isTankerPU ? 16 : 17;
        ctx.save();
        ctx.translate(ax, ay);
        ctx.rotate(ang);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';
        ctx.fillRect(-tpL / 2 + 1, -tpW / 2 + 1, tpL, tpW);
        ctx.fillStyle = isTankerPU ? '#c8c8c8' : '#e8e8e8';
        ctx.fillRect(-tpL / 2, -tpW / 2, tpL, tpW);
        if (!isTankerPU) {
          ctx.strokeStyle = 'rgba(0,0,0,0.1)';
          ctx.lineWidth = 0.3;
          for (let i = -tpL / 2 + 6; i < tpL / 2 - 4; i += 5) {
            ctx.beginPath();
            ctx.moveTo(i, -tpW / 2);
            ctx.lineTo(i, tpW / 2);
            ctx.stroke();
          }
        }
        ctx.restore();
      }
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
