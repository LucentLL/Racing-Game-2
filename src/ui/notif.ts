/**
 * Notification toast — top-of-screen banner with frame countdown.
 *
 * The simplest UI surface in the game: showNotif(msg, dur=120) sets
 * LIFE.notif + LIFE.notifTimer; tickNotif decrements per frame; drawNotif
 * paints when timer > 0.
 *
 * Visual: black band at GH*0.22, GW*0.9 wide, yellow bold 9px monospace
 * text centered. Default duration 120 frames (~2 seconds at 60 fps).
 *
 * Ported from monolith L42023 (showNotif), L34556-34562 (drawNotif),
 * L42325 (tickNotif decrement).
 *
 * SCAFFOLD status: showNotif and tickNotif are TINY enough to port in
 * full here — there is no meaningful "interior to defer." drawNotif
 * keeps the TODO stub for visual symmetry with the rest of D32.
 */

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
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillRect(GW * 0.05, GH * 0.22, GW * 0.9, 22);
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(state.notif, GW / 2, GH * 0.22 + 15);
  ctx.textAlign = 'left';
}
