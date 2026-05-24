/**
 * Job indicator HUD — small label at top-left showing the active job +
 * current step (pickup vs delivery). Companion to the minimap A/B
 * markers (already painted by drawMinimap) so the player has both a
 * map cue AND a text reminder of what they're doing.
 *
 * Without this widget the active job lives only on the minimap +
 * inside the pause-menu JOBS tab — the driver has to glance away from
 * the road to either spot. The label paints in the same band the
 * monolith uses (GH*0.33, left-anchored at x=4) so future GO-HOME /
 * race-indicator labels can compose into the same vertical strip.
 *
 * 1:1 inspired by monolith L34375-L34404 mainline branch. TOW DRIVER
 * / TRAFFIC COP / TRUCK DRIVER / FUEL TANKER per-job HUDs are
 * deferred — those need towJob / copJob / trailer state that modular
 * hasn't ported. Once those land, extend the branch table here.
 *
 * Race-active branch (monolith L34442 "🏁 RACE vs ...") also deferred
 * — drawRaceHud's racing-phase status bar already covers the racing
 * indicator at the top of the screen.
 */

import type { LifeState } from '@/state/life';

/** Paint the indicator. No-op when no job is active. */
export function drawJobIndicator(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GH: number,
): void {
  const job = life.job;
  if (!job) return;
  const status = job.pickedUp ? 'DELIVER ▶B' : 'PICKUP ▶A';
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(job.type + ' $' + job.pay + ' [' + status + ']', 4, GH * 0.33);
}
