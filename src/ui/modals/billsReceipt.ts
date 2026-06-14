/**
 * Bills receipt popup — informational modal surfacing the most-recent
 * monthly-bills cycle when the player opens home. Without it the
 * monolith's fireMonthlyBills just silently drains cash, leaving the
 * player wondering "what just happened to my money?" (especially on
 * the first 1st-of-month they hit).
 *
 * H575 SCOPE: informational only. Auto-pay semantics of
 * fireMonthlyBills are unchanged — this popup shows what already got
 * paid, plus paid-off / missed-payment cues. PAY HOME / PAY CARS /
 * SKIP-section interactive controls (monolith's full L47601-L47800
 * popup) are deferred to a follow-up that refactors fireMonthlyBills
 * to skip the auto-pay when the popup is up.
 *
 * Modal appears only when the player is at home (drawHomeOverlay
 * gates the paint). Eats every tap. DISMISS clears
 * life.billsDuePrompt + life.billsReceipt.
 *
 * 1:1 inspired by monolith L47601-L47800 simplified to single-DISMISS
 * receipt rather than two-section pay/skip popup.
 */

import type { LifeState } from '@/state/life';
import { MONTH_NAMES_FULL as MONTH_NAMES } from '@/config/calendar';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';

/** Snapshot stashed at life.billsReceipt by fireMonthlyBills. */
export interface BillsReceiptSnapshot {
  /** Month number (1-indexed) the cycle landed on. */
  month: number;
  /** Housing payment (rent or mortgage). */
  housing: number;
  /** Total of all car-loan monthly payments. */
  loanTotal: number;
  /** Loans that paid off this cycle. */
  paidOffCount: number;
  /** True if the player went insolvent on this cycle. */
  missed: boolean;
}

interface BillsReceiptHits {
  dismiss: { x: number; y: number; w: number; h: number };
}

/** Paint the modal. No-op unless life.billsDuePrompt and
 *  life.billsReceipt are both set. */
export function drawBillsReceipt(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  if (!life.billsDuePrompt) return;
  const receipt = life.billsReceipt as BillsReceiptSnapshot | null | undefined;
  if (!receipt) return;

  // H780: GT2 charcoal + grid backdrop replaces the prior dim rgba
  // wash so this popup reads as the same surface family as the rest
  // of the menu chrome.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);
  ctx.textAlign = 'center';
  const popW = GW - 40;
  const popX = 20;
  const popY = Math.floor(GH * 0.18);
  const popH = 220;
  ctx.fillStyle = 'rgba(0,0,0,0.92)';
  ctx.fillRect(popX, popY, popW, popH);
  ctx.strokeStyle = receipt.missed ? GT2_COLORS.amberDark : GT2_COLORS.amber;
  ctx.lineWidth = 2;
  ctx.strokeRect(popX, popY, popW, popH);
  ctx.lineWidth = 1;

  // Title — month name in the receipt's color.
  const monthIdx = ((receipt.month - 1) % 12 + 12) % 12;
  const monthName = MONTH_NAMES[monthIdx] ?? 'MONTH';
  ctx.fillStyle = receipt.missed ? GT2_COLORS.amberDark : GT2_COLORS.active;
  ctx.font = 'bold 13px monospace';
  ctx.fillText('MONTHLY BILLS — ' + monthName.toUpperCase(), GW / 2, popY + 22);

  let cy = popY + 50;
  // Housing line.
  if (receipt.housing > 0) {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('HOUSING', GW / 2, cy);
    cy += 14;
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('-$' + receipt.housing.toLocaleString(), GW / 2, cy);
    cy += 22;
  }
  // Cars + bank line.
  if (receipt.loanTotal > 0) {
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('CARS + BANK LOANS', GW / 2, cy);
    cy += 14;
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 12px monospace';
    ctx.fillText('-$' + receipt.loanTotal.toLocaleString(), GW / 2, cy);
    cy += 22;
  }
  // Total.
  const totalDue = receipt.housing + receipt.loanTotal;
  if (totalDue > 0) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('TOTAL: $' + totalDue.toLocaleString(), GW / 2, cy);
    cy += 18;
  }
  // Paid-off banner.
  if (receipt.paidOffCount > 0) {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.font = 'bold 11px monospace';
    ctx.fillText(
      receipt.paidOffCount + ' loan' + (receipt.paidOffCount > 1 ? 's' : '') + ' paid off!',
      GW / 2, cy,
    );
    cy += 16;
  }
  // Missed-payment warning.
  if (receipt.missed) {
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = 'bold 11px monospace';
    ctx.fillText('MISSED PAYMENT — CREDIT HIT', GW / 2, cy);
    cy += 12;
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.font = '9px monospace';
    ctx.fillText('Cash insufficient — debt accrued; credit -40 each section.', GW / 2, cy);
    cy += 14;
  }
  // No-bills-due case (paid-off loan only).
  if (totalDue <= 0 && receipt.paidOffCount === 0 && !receipt.missed) {
    ctx.fillStyle = GT2_COLORS.textMute;
    ctx.font = '10px monospace';
    ctx.fillText('No bills due this month.', GW / 2, cy);
    cy += 14;
  }

  // DISMISS button anchored to the bottom of the panel.
  const btnY = popY + popH - 38;
  const btnH = 28;
  const btnW = popW - 80;
  const btnX = popX + 40;
  ctx.fillStyle = 'rgba(255,122,24,0.20)';
  ctx.fillRect(btnX, btnY, btnW, btnH);
  ctx.strokeStyle = GT2_COLORS.amber;
  ctx.strokeRect(btnX, btnY, btnW, btnH);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('DISMISS', GW / 2, btnY + 18);
  ctx.textAlign = 'left';

  (life as { _billsReceiptHits?: BillsReceiptHits })._billsReceiptHits = {
    dismiss: { x: btnX, y: btnY, w: btnW, h: btnH },
  };
}

/** Routes a tap. Modal swallows every tap so the player can't fall
 *  through to the home overlay underneath. */
export function handleBillsReceiptTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  if (!life.billsDuePrompt) return false;
  const hits = (life as { _billsReceiptHits?: BillsReceiptHits })._billsReceiptHits;
  if (!hits) return true;
  const inside = (r: { x: number; y: number; w: number; h: number }): boolean =>
    tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (inside(hits.dismiss)) {
    life.billsDuePrompt = false;
    life.billsReceipt = null;
    return true;
  }
  return true; // swallow stray taps
}
