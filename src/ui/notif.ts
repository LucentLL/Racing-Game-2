/**
 * Notification toast — top-of-screen banner with frame countdown.
 *
 * The simplest UI surface in the game: showNotif(msg, dur=120) sets
 * LIFE.notif + LIFE.notifTimer; tickNotif decrements per frame; drawNotif
 * paints when timer > 0.
 *
 * Visual (H859): GT2 charcoal band at GH*0.22, GW*0.9 wide, with a thin
 * active-orange left-edge accent and amber bold 9px monospace text —
 * matching the locked GT2 chrome instead of the old black+yellow neon.
 * Default duration 120 frames (~2 seconds at 60 fps).
 *
 * Ported from monolith L42023 (showNotif), L34556-34562 (drawNotif),
 * L42325 (tickNotif decrement). All three landed at H619 — the
 * D32-era "SCAFFOLD" tag in earlier revisions of this header is gone.
 */

import { GT2_COLORS } from '@/ui/gt2Chrome';

/** Notification state — caller owns the LIFE-shaped slot for these. */
export interface NotifState {
  /** Current message ('' when timer===0). */
  notif: string;
  /** Frames remaining (0 = invisible). */
  notifTimer: number;
}

/** Per-frame inputs for the notif draw pass. */
export interface NotifOpts {
  state: NotifState;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Default duration when caller doesn't supply one (frames). */
export const DEFAULT_NOTIF_FRAMES = 120;

/** Mutates the supplied state — sets msg + timer. The caller wires this
 *  to LIFE.notif / LIFE.notifTimer. */
export function showNotif(
  state: NotifState,
  msg: string,
  dur: number = DEFAULT_NOTIF_FRAMES,
): void {
  state.notif = msg;
  state.notifTimer = dur;
}

/** Per-frame decrement. Runs in lifeSimTick (L42325). */
export function tickNotif(state: NotifState): void {
  if (state.notifTimer > 0) state.notifTimer--;
}

/** Draws the toast band when notifTimer > 0. No-op otherwise.
 *  1:1 port of monolith L34474-34480. */
export function drawNotif(
  ctx: CanvasRenderingContext2D,
  opts: NotifOpts,
): void {
  const { state, GW, GH } = opts;
  if (state.notifTimer <= 0) return;
  const bx = GW * 0.05;
  const by = GH * 0.22;
  const bw = GW * 0.9;
  const bh = 22;
  // GT2 charcoal band + thin active-orange left-edge accent.
  ctx.fillStyle = 'rgba(18, 18, 18, 0.88)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = GT2_COLORS.active;
  ctx.fillRect(bx, by, 3, bh);
  ctx.fillStyle = GT2_COLORS.amber;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(state.notif, GW / 2, by + 15);
  ctx.textAlign = 'left';
}
