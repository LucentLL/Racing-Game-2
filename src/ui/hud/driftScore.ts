/**
 * H851: drift scoring + combo overlay — the arcade reward layer for the
 * GT×NFS game-feel work. PURELY a score/UI layer over physics that
 * already exists: it reads the integrator-synced player fields
 * (drifting / slipAngle / pSpeed / collisionFlash) and never touches the
 * simulation. No monolith equivalent — invented per the game-feel brief.
 *
 * Model (standard arcade drift-combo):
 *   - While the car is genuinely drifting (drifting flag + above a slip
 *     and speed floor), `current` accumulates  |slip| × speed × dt.
 *   - CHAINING: ending one drift opens a CHAIN_WINDOW grace gap; starting
 *     another within it links the combo and bumps the multiplier. The
 *     accumulated `current` carries across the whole chain.
 *   - BANK: when the chain window lapses without a new drift, the chain
 *     banks  round(current × multiplier)  into the session total and a
 *     "+N" popup fires.
 *   - WRECK: any fresh collision (a rising edge on player.collisionFlash)
 *     while a chain is live busts the un-banked points and resets the
 *     multiplier — the risk that makes the reward mean something.
 *
 * Styling matches the locked GT2 amber-on-charcoal standard (no emoji).
 */

import { GT2_COLORS } from '@/ui/gt2Chrome';

/** Points = |slipAngle(rad)| × speed(gu/s) × dt × this. Tuned so a solid
 *  3-4s drift banks a few thousand; refine by feel. */
const SCORE_SCALE = 120;
/** Slip floor (rad ≈ 9°) below which the car is cornering, not drifting. */
const MIN_SLIP = 0.16;
/** Speed floor (gu/s) — no scoring at a parking-lot crawl. */
const MIN_SPEED = 18;
/** Grace gap (s) between drift links that still chains the combo. */
const CHAIN_WINDOW = 1.3;
/** Don't fire a bank popup for trivial dust-ups. */
const BANK_MIN = 50;
/** Bank / wreck popup lifetime (s). */
const POPUP_TIME = 1.7;
/** Burnt red-orange for a WRECKED bust — reads as "bad" but stays in the
 *  warm GT2 family rather than a clashing pure red. */
const WRECK_COLOR = '#c85a3a';

export interface DriftScoreState {
  /** Currently inside a scoring drift this frame. */
  active: boolean;
  /** Points accumulated across the live chain (pre-multiplier). */
  current: number;
  /** Combo multiplier (1, 2, 3…) — one per chained drift link. */
  multiplier: number;
  /** Grace countdown (s) between drift links; >0 means the chain is open. */
  chainTimer: number;
  /** Total banked points this run (kept for a future race/rep hook). */
  banked: number;
  /** Fade 0..1 for the live readout. */
  liveAlpha: number;
  /** Transient popup ("+N" or "WRECKED"). */
  popupText: string;
  popupTimer: number;
  popupBust: boolean;
  /** Previous-frame collisionFlash, for rising-edge wreck detection. */
  prevFlash: number;
}

/** Minimal read view the tick needs from PlayerState. */
export interface DriftScoreInput {
  pSpeed: number;
  slipAngle: number;
  drifting: boolean;
  collisionFlash: number;
}

function freshState(): DriftScoreState {
  return {
    active: false, current: 0, multiplier: 1, chainTimer: 0, banked: 0,
    liveAlpha: 0, popupText: '', popupTimer: 0, popupBust: false, prevFlash: 0,
  };
}

/** Module singleton — drift scoring is transient run state, not saved. */
export const driftScore: DriftScoreState = freshState();

/** Reset the combo (new game / car switch / race start / teleport). Keeps
 *  the prevFlash baseline so a teleport doesn't read as a wreck. */
export function resetDriftScore(): void {
  const pf = driftScore.prevFlash;
  Object.assign(driftScore, freshState());
  driftScore.prevFlash = pf;
}

/** Advance the drift-score state once per frame while DRIVING (caller
 *  gates out paused / menu / home / map frames so a frozen drift can't
 *  keep banking). Reads only — never mutates the player. */
export function tickDriftScore(p: DriftScoreInput, dt: number): void {
  if (dt <= 0) return;

  // WRECK: a rising edge on collisionFlash during a live chain busts it.
  const hit = p.collisionFlash > driftScore.prevFlash + 0.001;
  driftScore.prevFlash = p.collisionFlash;
  if (hit && (driftScore.active || driftScore.current > 0)) {
    if (driftScore.current * driftScore.multiplier >= BANK_MIN) {
      driftScore.popupText = 'WRECKED';
      driftScore.popupBust = true;
      driftScore.popupTimer = POPUP_TIME;
    }
    driftScore.active = false;
    driftScore.current = 0;
    driftScore.multiplier = 1;
    driftScore.chainTimer = 0;
  }

  const spd = Math.abs(p.pSpeed);
  const slip = Math.abs(p.slipAngle);
  const scoring = p.drifting && spd > MIN_SPEED && slip > MIN_SLIP;

  if (scoring) {
    if (!driftScore.active) {
      // Start of a drift link. If the chain window is still open this is a
      // chained link → bump the multiplier; otherwise it's a fresh combo.
      if (driftScore.chainTimer > 0) driftScore.multiplier += 1;
      else { driftScore.multiplier = 1; driftScore.current = 0; }
      driftScore.active = true;
    }
    driftScore.current += slip * spd * dt * SCORE_SCALE;
    driftScore.chainTimer = CHAIN_WINDOW; // hold the window open while sliding
    driftScore.liveAlpha = Math.min(1, driftScore.liveAlpha + dt * 6);
  } else {
    driftScore.active = false;
    if (driftScore.chainTimer > 0) {
      driftScore.chainTimer -= dt;
      if (driftScore.chainTimer <= 0) {
        // Chain lapsed → bank it.
        const pts = Math.round(driftScore.current * driftScore.multiplier);
        if (pts >= BANK_MIN) {
          driftScore.banked += pts;
          driftScore.popupText = '+' + pts.toLocaleString();
          driftScore.popupBust = false;
          driftScore.popupTimer = POPUP_TIME;
        }
        driftScore.current = 0;
        driftScore.multiplier = 1;
      }
    }
    driftScore.liveAlpha = Math.max(0, driftScore.liveAlpha - dt * 4);
  }

  if (driftScore.popupTimer > 0) driftScore.popupTimer = Math.max(0, driftScore.popupTimer - dt);
}

/** Paint the live combo readout + the bank/wreck popup. Cheap: at most a
 *  few fills/strokes, and a full no-op when nothing is active (so it costs
 *  nothing on the stable-FPS budget when you're not drifting). */
export function drawDriftScore(ctx: CanvasRenderingContext2D, W: number, H: number): void {
  const s = driftScore;
  const showLive = s.current > 0 && s.liveAlpha > 0.01;
  if (!showLive && s.popupTimer <= 0) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = W / 2;
  const baseY = H * 0.205;

  if (showLive) {
    const pts = Math.round(s.current * s.multiplier);
    ctx.globalAlpha = s.liveAlpha;
    // Score number.
    ctx.font = `700 ${Math.round(H * 0.052)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 6;
    ctx.fillText(pts.toLocaleString(), cx, baseY);
    // Multiplier chip (only once chained).
    if (s.multiplier > 1) {
      ctx.font = `700 ${Math.round(H * 0.032)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillStyle = GT2_COLORS.active;
      ctx.fillText('×' + s.multiplier, cx, baseY + H * 0.05);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  if (s.popupTimer > 0) {
    const a = Math.min(1, s.popupTimer / (POPUP_TIME * 0.6));
    const rise = (1 - s.popupTimer / POPUP_TIME) * H * 0.04;
    ctx.globalAlpha = a;
    ctx.font = `700 ${Math.round(H * 0.040)}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = s.popupBust ? WRECK_COLOR : GT2_COLORS.active;
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 6;
    ctx.fillText(s.popupText, cx, baseY + H * 0.105 - rise);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}
