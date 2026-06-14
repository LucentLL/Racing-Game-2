/**
 * Confirmation modal — generic YES/NO prompt overlay used by
 * destructive pause-menu actions (RESTART for now; the type union
 * accepts more actions when QUIT or DELETE SAVE need confirms too).
 *
 * Ported from monolith L35730-35774 (draw) + L41943-41975 (execute +
 * tap dispatch). Single panel (~220x130) centered on the HUD canvas
 * with a dark backdrop, word-wrapped message body, and two buttons.
 *
 * Render contract: drawConfirmPrompt paints onto the HUD canvas
 * AFTER the pause menu (so it sits on top), caches the YES/NO rects
 * onto life._confirmYesRect / life._confirmNoRect for the tap
 * handler. handleConfirmPromptTap hit-tests those cached rects;
 * taps outside the buttons are swallowed (modal eats input) but
 * don't dismiss — the player must use NO. Same UX as the monolith.
 */

import type { LifeState } from '@/state/life';
import { clearSave } from '@/save/interim';
import { GT2_COLORS, drawGt2Backdrop } from '@/ui/gt2Chrome';

/** Actions a confirm prompt can execute on YES. Open union — add
 *  more entries (and an executeConfirmAction branch) as further
 *  destructive flows port. */
export type ConfirmAction = 'restart';

/** LIFE._confirmPrompt shape. Set when a button opens the confirm,
 *  cleared by the modal's own YES/NO (or by external code that
 *  needs to dismiss programmatically). */
export interface ConfirmPromptState {
  action: ConfirmAction;
  title: string;
  msg: string;
}

/** Rect cached on LIFE by the draw pass, consumed by the tap pass. */
interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Execute the pending confirm action. Clears the prompt first so
 *  re-entrant draws don't re-prompt. 1:1 port of monolith
 *  executeConfirmAction at L41943-41958 minus the 'quit' branch
 *  (modular optQuit takes the non-destructive save+title-return
 *  path and so doesn't need confirm). */
function executeConfirmAction(life: LifeState): void {
  const cp = life._confirmPrompt;
  if (!cp) return;
  life._confirmPrompt = null;
  if (cp.action === 'restart') {
    // Clear save first so the reload lands on a fresh title screen
    // instead of auto-loading the state the player just asked to
    // wipe. Monolith doesn't clear (its restart just reloads to
    // last autosave) — modular's RESTART means "discard this run",
    // matching what the menu label implies on the OPT tab.
    try { clearSave(); } catch { /* swallow quota / SecurityError */ }
    try { window.location.reload(); } catch { /* iframe sandboxed */ }
  }
}

/** Draw the modal. No-op when life._confirmPrompt is null. Paints
 *  onto the SAME canvas as the pause menu (HUD ctx), centered on
 *  GW/GH. Caches the YES/NO rects onto life so the tap handler
 *  can hit-test without re-running layout. */
export function drawConfirmPrompt(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
): void {
  const cp = life._confirmPrompt;
  if (!cp) return;

  // H780: GT2 charcoal + grid backdrop.
  ctx.fillStyle = GT2_COLORS.bg;
  ctx.fillRect(0, 0, GW, GH);
  drawGt2Backdrop(ctx, GW, GH);

  const pW = Math.min(GW - 24, 220);
  const pH = 130;
  const pX = (GW - pW) / 2;
  const pY = (GH - pH) / 2;
  ctx.fillStyle = 'rgba(25, 25, 40, 0.95)';
  ctx.fillRect(pX, pY, pW, pH);
  ctx.strokeStyle = GT2_COLORS.amberDark;
  ctx.lineWidth = 2;
  ctx.strokeRect(pX, pY, pW, pH);

  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 13px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(cp.title, GW / 2, pY + 22);

  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = '10px monospace';
  const words = cp.msg.split(' ');
  let line = '';
  const lines: string[] = [];
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > pW - 20) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, GW / 2, pY + 44 + i * 14));

  const bY = pY + pH - 34;
  const bW = 80;
  const bH = 24;
  const noX = pX + 12;
  const yesX = pX + pW - 12 - bW;

  ctx.fillStyle = 'rgba(80, 80, 80, 0.4)';
  ctx.fillRect(noX, bY, bW, bH);
  ctx.strokeStyle = GT2_COLORS.textMute;
  ctx.lineWidth = 1;
  ctx.strokeRect(noX, bY, bW, bH);
  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 12px monospace';
  ctx.fillText('NO', noX + bW / 2, bY + 16);

  ctx.fillStyle = 'rgba(163,110,21,0.4)';
  ctx.fillRect(yesX, bY, bW, bH);
  ctx.strokeStyle = GT2_COLORS.amberDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(yesX, bY, bW, bH);
  ctx.fillStyle = GT2_COLORS.amberDark;
  ctx.fillText('YES', yesX + bW / 2, bY + 16);

  ctx.textAlign = 'left';

  life._confirmNoRect = { x: noX, y: bY, w: bW, h: bH };
  life._confirmYesRect = { x: yesX, y: bY, w: bW, h: bH };
}

/** Hit-test YES/NO. Returns true when the modal consumed the tap
 *  (either button or a generic swallow). Caller should bail out of
 *  further tap routing on true. 1:1 with monolith
 *  handleConfirmPromptTap at L41962-41975. */
export function handleConfirmPromptTap(
  tx: number,
  ty: number,
  life: LifeState,
): boolean {
  if (!life._confirmPrompt) return false;
  const yr = life._confirmYesRect;
  const nr = life._confirmNoRect;
  const inRect = (r: ButtonRect | undefined): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (inRect(yr)) {
    executeConfirmAction(life);
    return true;
  }
  if (inRect(nr)) {
    life._confirmPrompt = null;
    return true;
  }
  // Tap outside YES/NO while modal is up — swallow but don't dismiss.
  return true;
}
