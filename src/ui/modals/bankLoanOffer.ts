/**
 * Bank loan offer modal — full-screen panel with discrete amount + term
 * pickers, live APR/monthly readout, and ACCEPT/CANCEL buttons.
 *
 * Opens when the player taps GET BANK LOAN on the BILLS tab. The modal
 * eats every tap until ACCEPT or CANCEL closes it (life.bankLoanOffer
 * set to null). evaluateBankLoan runs each frame so the player sees the
 * APR, monthly, and approval state update live as they tap different
 * amount + term combinations.
 *
 * Ported from monolith drawBankLoanOffer L49259-L49400 and the click
 * dispatch at L50584/L50823. Modular adaptation: the amount/term
 * picker hit rects are cached on life._bankOfferHits per paint so the
 * click router can route without re-running layout.
 */

import type { LifeState } from '@/state/life';
import {
  BANK_LOAN_TERMS,
  BANK_LOAN_AMOUNTS,
  evaluateBankLoan,
  originateBankLoan,
} from '@/sim/bankLoan';
import { getCreditTier } from '@/sim/credit';
import { showNotif } from '@/ui/notif';

/** State shape stored at life.bankLoanOffer. The two fields drive the
 *  modal's amount/term selection — every other piece (APR, monthly,
 *  approval) is derived per frame via evaluateBankLoan. */
export interface BankLoanOfferState {
  amount: number;
  term: number;
}

/** Cached hit rects from the last paint. The click router walks
 *  these instead of re-running layout. */
interface BankOfferHits {
  amounts: Array<{ amount: number; x: number; y: number; w: number; h: number }>;
  terms: Array<{ term: number; x: number; y: number; w: number; h: number }>;
  accept: { x: number; y: number; w: number; h: number } | null;
  cancel: { x: number; y: number; w: number; h: number } | null;
}

/** Render the modal. No-op when life.bankLoanOffer is null. */
export function drawBankLoanOffer(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const o = life.bankLoanOffer as BankLoanOfferState | null | undefined;
  if (!o) return;

  const bx = 14;
  const by = 40;
  const bw = GW - 28;
  const bh = GH - 80;
  ctx.fillStyle = 'rgba(0,0,0,0.95)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#fa0';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.lineWidth = 1;

  // Title + credit summary.
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fa0';
  ctx.font = 'bold 13px monospace';
  ctx.fillText('🏦 BANK LOAN OFFER', GW / 2, by + 18);
  const credit = getCreditTier((life.creditScore as number) ?? 650);
  ctx.fillStyle = credit.color;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(credit.tier + ' credit (' + ((life.creditScore as number) ?? 650) + ')', GW / 2, by + 34);

  // Amount picker — 4-col grid covering the seven discrete amounts.
  ctx.fillStyle = '#ccc';
  ctx.font = '9px monospace';
  ctx.fillText('AMOUNT', GW / 2, by + 50);
  const amtRects: BankOfferHits['amounts'] = [];
  const amtY = by + 56;
  const amtH = 22;
  const perRow = 4;
  const colW = Math.floor((bw - 12) / perRow);
  for (let i = 0; i < BANK_LOAN_AMOUNTS.length; i++) {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const ax = bx + 6 + col * colW;
    const ay = amtY + row * (amtH + 3);
    const amt = BANK_LOAN_AMOUNTS[i];
    const isSel = o.amount === amt;
    ctx.fillStyle = isSel ? 'rgba(255,170,0,0.35)' : 'rgba(60,60,80,0.4)';
    ctx.fillRect(ax, ay, colW - 4, amtH);
    ctx.strokeStyle = isSel ? '#fa0' : '#555';
    ctx.strokeRect(ax, ay, colW - 4, amtH);
    ctx.fillStyle = isSel ? '#fff' : '#aaa';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    const lbl = amt >= 1000 ? '$' + amt / 1000 + 'k' : '$' + amt;
    ctx.fillText(lbl, ax + (colW - 4) / 2, ay + 14);
    amtRects.push({ amount: amt, x: ax, y: ay, w: colW - 4, h: amtH });
  }
  const amtRows = Math.ceil(BANK_LOAN_AMOUNTS.length / perRow);
  let cy = amtY + amtRows * (amtH + 3) + 8;

  // Term picker.
  ctx.fillStyle = '#ccc';
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('TERM (months)', GW / 2, cy);
  cy += 6;
  const termRects: BankOfferHits['terms'] = [];
  const termH = 22;
  const termCols = BANK_LOAN_TERMS.length;
  const termColW = Math.floor((bw - 12) / termCols);
  for (let i = 0; i < BANK_LOAN_TERMS.length; i++) {
    const t = BANK_LOAN_TERMS[i];
    const tx2 = bx + 6 + i * termColW;
    const isSel = o.term === t;
    ctx.fillStyle = isSel ? 'rgba(255,170,0,0.35)' : 'rgba(60,60,80,0.4)';
    ctx.fillRect(tx2, cy, termColW - 4, termH);
    ctx.strokeStyle = isSel ? '#fa0' : '#555';
    ctx.strokeRect(tx2, cy, termColW - 4, termH);
    ctx.fillStyle = isSel ? '#fff' : '#aaa';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(t + ' mo', tx2 + (termColW - 4) / 2, cy + 14);
    termRects.push({ term: t, x: tx2, y: cy, w: termColW - 4, h: termH });
  }
  cy += termH + 10;

  // Live decision — APR + monthly + denial reason.
  const ev = evaluateBankLoan(life, o.amount, o.term);
  ctx.fillStyle = '#ccc';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('APR: ' + (ev.apr * 100).toFixed(1) + '%', GW / 2, cy);
  cy += 14;
  ctx.fillStyle = ev.approved ? '#0f0' : '#f88';
  ctx.font = 'bold 11px monospace';
  if (ev.approved) {
    ctx.fillText('Monthly: $' + ev.monthly.toLocaleString(), GW / 2, cy);
    cy += 14;
    ctx.fillStyle = '#aaa';
    ctx.font = '9px monospace';
    const total = ev.monthly * o.term;
    const interest = total - o.amount;
    ctx.fillText(
      'Total repaid: $' + total.toLocaleString()
      + ' (interest $' + interest.toLocaleString() + ')',
      GW / 2, cy,
    );
    cy += 14;
  } else {
    // Word-wrap denial reason so long messages don't clip.
    const reasonText = '✗ ' + ev.reason;
    const maxW = bw - 16;
    const words = reasonText.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur);
        cur = w;
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    for (const ln of lines) {
      ctx.fillText(ln, GW / 2, cy);
      cy += 12;
    }
    cy += 2;
  }

  // ACCEPT / CANCEL buttons at the bottom of the panel.
  const btnY = by + bh - 38;
  const btnH = 26;
  const btnW = (bw - 18) / 2;
  const canAccept = ev.approved;
  // ACCEPT — green when approved, greyed otherwise.
  ctx.fillStyle = canAccept ? 'rgba(0,200,100,0.25)' : 'rgba(60,60,60,0.2)';
  ctx.fillRect(bx + 6, btnY, btnW, btnH);
  ctx.strokeStyle = canAccept ? '#0f0' : '#555';
  ctx.strokeRect(bx + 6, btnY, btnW, btnH);
  ctx.fillStyle = canAccept ? '#0f0' : '#666';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('✓ ACCEPT LOAN', bx + 6 + btnW / 2, btnY + 17);
  // CANCEL — always red.
  ctx.fillStyle = 'rgba(255,80,80,0.2)';
  ctx.fillRect(bx + 12 + btnW, btnY, btnW, btnH);
  ctx.strokeStyle = '#f88';
  ctx.strokeRect(bx + 12 + btnW, btnY, btnW, btnH);
  ctx.fillStyle = '#f88';
  ctx.fillText('✗ CANCEL', bx + 12 + btnW + btnW / 2, btnY + 17);
  ctx.textAlign = 'left';

  (life as { _bankOfferHits?: BankOfferHits })._bankOfferHits = {
    amounts: amtRects,
    terms: termRects,
    accept: { x: bx + 6, y: btnY, w: btnW, h: btnH },
    cancel: { x: bx + 12 + btnW, y: btnY, w: btnW, h: btnH },
  };
}

/** Routes a tap through the cached hits. Returns true when consumed.
 *  Modal eats every tap (any tap outside a button still returns true)
 *  so the player can't fall through to the bills tab beneath. */
export function handleBankLoanOfferTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  const o = life.bankLoanOffer as BankLoanOfferState | null | undefined;
  if (!o) return false;
  const hits = (life as { _bankOfferHits?: BankOfferHits })._bankOfferHits;
  if (!hits) return true; // modal up but pre-first-paint; swallow tap
  const inside = (r: { x: number; y: number; w: number; h: number } | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  // Amount buttons.
  for (const r of hits.amounts) {
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
      o.amount = r.amount;
      return true;
    }
  }
  // Term buttons.
  for (const r of hits.terms) {
    if (tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h) {
      o.term = r.term;
      return true;
    }
  }
  // CANCEL.
  if (inside(hits.cancel)) {
    life.bankLoanOffer = null;
    return true;
  }
  // ACCEPT (gated on approval).
  if (inside(hits.accept)) {
    const ev = evaluateBankLoan(life, o.amount, o.term);
    if (!ev.approved) {
      showNotif(life, '✗ ' + ev.reason, 180);
      return true;
    }
    originateBankLoan(life, o.amount, o.term, ev.apr, ev.monthly);
    showNotif(life, '💰 Bank loan approved: +$' + o.amount.toLocaleString(), 240);
    life.bankLoanOffer = null;
    return true;
  }
  return true; // modal swallows stray taps
}
