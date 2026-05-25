/**
 * Broken-car indicator — big red BREAKDOWN! text + tappable CALL TOW
 * button.
 *
 * Paints when LIFE.broken is set:
 *   - row 1 at GH*0.40 — bold 14px red text. Uses LIFE.breakdownType
 *     when present (e.g. "ENGINE FAILURE"), falls back to plain
 *     "BREAKDOWN!".
 *   - row 2 at GH*0.42 — orange 100×20 "📞 CALL TOW" button, only
 *     visible while breakdownTimer<=0 AND no tow is already inbound
 *     AND no tow menu is open. Tapping it sets LIFE.towMenuOpen=true.
 *
 * Ported from monolith L34514-34526 (draw) + L22051 (the central tap
 * route — `tx>=GW/2-50 && tx<=GW/2+50 && ty>=GH*0.42 && ty<=GH*0.42+20`).
 *
 * Live as of H619: H532-H536 wired the fault system + maybeRollBreakdown
 * trigger, H557 added the out-of-gas trigger, H563 ported the tow-menu
 * modal. Both branches now flip LIFE.broken and the click handler routes
 * through to the working modal. Earlier "DORMANT" caveats removed.
 */

/** LIFE slot the indicator reads. All fields optional so the type
 *  passes through unchanged when nothing is broken (steady state). */
export interface BreakdownLife {
  broken?: boolean;
  breakdownType?: string;
  breakdownTimer?: number;
  towMenuOpen?: boolean;
  incomingTow?: unknown;
}

/** Hit-test box for the CALL TOW button. */
export function breakdownTowRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  return { x: GW / 2 - 50, y: GH * 0.42, w: 100, h: 20 };
}

/** True when the CALL TOW button is currently *visible* — both the
 *  broken-state gate (must be broken) and the v8.91 suppress gate
 *  (already-towing / menu-open suppressions) need to pass. Click
 *  router uses this to decide whether to consume the tap. */
export function isCallTowVisible(life: BreakdownLife): boolean {
  if (!life.broken) return false;
  if ((life.breakdownTimer ?? 0) > 0) return false;
  if (life.towMenuOpen) return false;
  if (life.incomingTow) return false;
  return true;
}

/** Hit-test for the visible button. Returns false when the button
 *  isn't being painted — saves the caller from doing the visibility
 *  + bounds checks separately. */
export function isCallTowHit(
  tx: number,
  ty: number,
  GW: number,
  GH: number,
  life: BreakdownLife,
): boolean {
  if (!isCallTowVisible(life)) return false;
  const { x, y, w, h } = breakdownTowRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}

/** Draws the broken indicator. 1:1 port of monolith L34514-34526.
 *  No-op when not broken. */
export function drawBreakdownIndicator(
  ctx: CanvasRenderingContext2D,
  life: BreakdownLife,
  GW: number,
  GH: number,
): void {
  if (!life.broken) return;
  ctx.fillStyle = '#f00';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(life.breakdownType || 'BREAKDOWN!', GW / 2, GH * 0.40);
  if (isCallTowVisible(life)) {
    const { x: bx, y: by, w: bw, h: bh } = breakdownTowRect(GW, GH);
    ctx.fillStyle = 'rgba(255, 80, 0, 0.3)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = '#f80';
    ctx.strokeRect(bx, by, bw, bh);
    ctx.fillStyle = '#f80';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('📞 CALL TOW', GW / 2, by + 14);
  }
  ctx.textAlign = 'left';
}
