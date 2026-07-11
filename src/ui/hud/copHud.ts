/**
 * H704: TRAFFIC COP HUD — phase status line + contextual action
 * button (ACCEPT alert / ISSUE TICKET).
 *
 * Active only while LIFE.playerJob === 'TRAFFIC COP' AND LIFE.copJob
 * exists. Mirrors monolith L21000-L21548 routing for the cop-job
 * tap buttons (the monolith renders inline inside the main HUD
 * branch; modular extracts to a self-contained module for parity
 * with the breakdown / pursuit / nearPin pattern).
 *
 * The button positions intentionally avoid the GH*0.42 CALL TOW
 * row + GH*0.35 NEAR PIN row so a stranded-on-cop-shift player
 * doesn't get overlapping tap zones. Cop button sits at GH*0.50.
 */

import type { CopJobState } from '@/sim/trafficCop';

/** LIFE slot the HUD reads. All optional — falls through cleanly
 *  when the player isn't on the cop shift. */
export interface CopHudLife {
  playerJob?: string;
  copJob?: unknown;
  jobDoneToday?: boolean;
}

/** Hit-test box for the cop action button (ACCEPT or ISSUE
 *  TICKET — never both at once). */
export function copActionRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 60, y: GH * 0.50, w: 120, h: 22 };
}

/** True while the player is mid-shift as TRAFFIC COP — gates the
 *  phase status line and the button visibility checks below. */
function isOnCopShift(life: CopHudLife): boolean {
  return (
    life.playerJob === 'TRAFFIC COP'
    && !!life.copJob
    && !life.jobDoneToday
  );
}

/** True when the ACCEPT button should paint AND respond to taps —
 *  radar phase has surfaced an alert, player hasn't engaged yet. */
export function isAcceptVisible(life: CopHudLife): boolean {
  if (!isOnCopShift(life)) return false;
  const cj = life.copJob as CopJobState;
  return cj.phase === 'radar' && cj.alertCarIdx >= 0;
}

/** True when the ISSUE TICKET button should paint AND respond to
 *  taps — 'bumped' phase reached, player needs to confirm. */
export function isIssueTicketVisible(life: CopHudLife): boolean {
  if (!isOnCopShift(life)) return false;
  const cj = life.copJob as CopJobState;
  return cj.phase === 'bumped';
}

/** Combined hit-test for whichever cop action is currently
 *  visible. Returns the action kind or null when neither button
 *  is painted at the supplied (tx,ty). */
export function isCopActionHit(
  tx: number,
  ty: number,
  GW: number,
  GH: number,
  life: CopHudLife,
): 'accept' | 'ticket' | null {
  const { x, y, w, h } = copActionRect(GW, GH);
  if (tx < x || tx > x + w || ty < y || ty > y + h) return null;
  if (isAcceptVisible(life)) return 'accept';
  if (isIssueTicketVisible(life)) return 'ticket';
  return null;
}

/** Paint the cop status line + active button. No-op off-shift. */
export function drawCopHud(
  ctx: CanvasRenderingContext2D,
  life: CopHudLife,
  GW: number,
  GH: number,
): void {
  if (!isOnCopShift(life)) return;
  const cj = life.copJob as CopJobState;

  ctx.textAlign = 'center';
  ctx.font = 'bold 10px monospace';
  let label = '';
  let color = '#fff';
  if (cj.phase === 'radar') {
    if (cj.alertCarIdx >= 0) {
      const speed = cj._alertSpeed ?? 0;
      const limit = cj._alertLimit ?? 0;
      label = '⚠ Speeder: ' + speed + ' in ' + limit + ' zone';
      color = '#fc0';
    } else {
      label = '🚔 ON RADAR — park to scan';
      color = '#0cf';
    }
  } else if (cj.phase === 'chasing') {
    label = '🚔 CHASING — tail or bump to pull over';
    color = '#f60';
  } else if (cj.phase === 'yielding') {
    // H1126: target is signalling + rolling to a stop on its own.
    label = '🚦 PULLING OVER — stay behind them';
    color = '#fc0';
  } else if (cj.phase === 'bumped') {
    label = '🚔 PULLED OVER — stop near them';
    color = '#0f0';
  }
  ctx.fillStyle = color;
  ctx.fillText(label, GW / 2, GH * 0.47);

  if (isAcceptVisible(life)) {
    drawButton(ctx, GW, GH, '✓ ACCEPT', '#0080ff');
  } else if (isIssueTicketVisible(life)) {
    drawButton(ctx, GW, GH, '🎫 ISSUE TICKET', '#0080ff');
  }
  ctx.textAlign = 'left';
}

function drawButton(
  ctx: CanvasRenderingContext2D,
  GW: number,
  GH: number,
  text: string,
  hex: string,
): void {
  const { x, y, w, h } = copActionRect(GW, GH);
  ctx.fillStyle = 'rgba(0, 128, 255, 0.3)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = hex;
  ctx.lineWidth = 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = hex;
  ctx.font = 'bold 11px monospace';
  ctx.fillText(text, GW / 2, y + 15);
}
