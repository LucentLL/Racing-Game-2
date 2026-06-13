/**
 * Race HUD overlay — four sub-phases driven off RACE.phase.
 *
 *   - 'ready' (v8.99.112) — pre-race confirmation modal. Player can
 *     open menus / map / garage to prep their car; nothing ticks until
 *     they tap START COUNTDOWN. Suppressed when menuOpen / carSelectOpen
 *     / fullMapOpen / homeScreenOpen so the prep surfaces are reachable.
 *     Buttons: START COUNTDOWN (green) + FORFEIT (red) — emit hit-rects
 *     into RACE._readyBtnRect / RACE._readyAbortRect.
 *
 *   - 'countdown' — big 3-2-1-GO! at center. No interaction.
 *
 *   - 'racing' — top status bar with position indicator (YOU LEAD /
 *     OPPONENT LEADS), per-side progress bars (cyan you, red opp), and
 *     a distance-to-finish readout in the player's preferred unit.
 *     Distance line in feet under 1 mile, miles otherwise.
 *
 *   - 'result' — win/loss screen with bet payout or pink-slip outcome
 *     (winning a pink-slip race adds the opponent's car to your garage;
 *     losing forfeits LIFE.lostCar permanently). Dismiss button below.
 *
 * Distance display respects v8.99.126.87 unit system: getEffectiveUnit
 * (active car) drives mph vs km/h labeling on race-distance lines.
 *
 * Ported from monolith L36109+ (the inline race HUD block at the tail
 * of render()). Full bodies for every phase landed at H222-H225 +
 * H587-H588 (finish/opponent minimap markers + full-map race pins);
 * the H619 sweep removed the obsolete "SCAFFOLD" header.
 *
 * H854: re-skinned from raw cyan/green/red + emoji to the locked GT2
 * amber-on-charcoal standard (GT2_COLORS) — the arcade payoff screens now
 * match every surrounding menu. Geometry, hit-rects, and interaction are
 * unchanged; only palette / emoji / button language moved.
 */

import { GT2_COLORS } from '@/ui/gt2Chrome';

/** GT2 panel fill — charcoal at near-opacity with a thin amber top
 *  accent, the standard treatment for the race overlays' floating cards. */
function gt2Panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = 'rgba(18,18,18,0.9)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = GT2_COLORS.active;
  ctx.fillRect(x, y, w, 2);
}

/** GT2 pill button. primary = active-orange fill with dark label;
 *  secondary = transparent with an amber outline + amber label. Centered
 *  text; caller owns the hit-rect. */
function gt2Pill(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number,
  label: string, fontPx: number, primary: boolean,
): void {
  if (primary) {
    ctx.fillStyle = GT2_COLORS.active;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = GT2_COLORS.bgDeep;
  } else {
    ctx.fillStyle = 'rgba(247,166,35,0.10)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = GT2_COLORS.amber;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = GT2_COLORS.amber;
  }
  ctx.font = `bold ${fontPx}px monospace`;
  ctx.fillText(label, x + w / 2, y + h / 2 + fontPx * 0.36);
}

/** Active race lifecycle phase. */
export type RacePhase =
  | 'setup'
  | 'ready'
  | 'approach'
  | 'travel'
  | 'countdown'
  | 'racing'
  | 'result'
  | '';

/** Per-frame inputs for the race HUD. */
export interface RaceHudOpts {
  /** Active phase — drives which sub-overlay renders. */
  phase: RacePhase;
  /** Opponent display name. */
  oppName: string;
  /** Bet amount ($). */
  bet: number;
  /** True for pink-slip races (visual treatment + result-screen copy). */
  pinkSlip: boolean;
  /** Race distance in tiles (drives the distance label when set). */
  raceDistance: number | null;
  /** Player display unit ('mph' | 'km'). */
  useMph: boolean;
  /** Tile size in world units (for distance conversion). */
  TILE: number;
  /** Countdown integer (3,2,1) or 0 (renders as 'GO!'). */
  countdown: number;
  /** Player + opponent world coords, finish + start (drive 'racing' bars). */
  px: number;
  py: number;
  oppX: number;
  oppY: number;
  startX: number;
  startY: number;
  finishX: number;
  finishY: number;
  /** Result phase: 'player' | 'opponent'. */
  winner: 'player' | 'opponent' | null;
  /** Pink-slip won-car name (when winner==='player' && pinkSlip). */
  wonCarName: string | null;
  /** Pink-slip lost-car id (when winner==='opponent' && pinkSlip). */
  lostCarId: string | null;
  /** Suppress flags — 'ready' phase hides when ANY of these are true. */
  menuOpen: boolean;
  carSelectOpen: boolean;
  fullMapOpen: boolean;
  homeScreenOpen: boolean;
  /** Canvas internal width / height. */
  GW: number;
  GH: number;
}

/** Tap rects emitted by the 'ready' phase. */
export interface RaceHudRects {
  startCountdown: { x: number; y: number; w: number; h: number } | null;
  forfeit: { x: number; y: number; w: number; h: number } | null;
  /** Result-screen dismiss button. */
  dismiss: { x: number; y: number; w: number; h: number } | null;
}

/** Side effects of taps in 'ready' / 'result' phases. */
export interface RaceHudDeps {
  /** START COUNTDOWN — flips RACE.phase to 'countdown'. */
  startCountdown(): void;
  /** FORFEIT — clears RACE.active, RACE.phase. */
  forfeit(): void;
  /** Result-screen dismiss — clears RACE / returns to gameplay. */
  dismissResult(): void;
}

/** H223: 'ready' phase body — pre-race confirmation modal. The
 *  countdown / racing / result branches port in H224+ commits.
 *  When ANY of menuOpen / carSelectOpen / fullMapOpen /
 *  homeScreenOpen is true, the modal is suppressed (lets the
 *  player prep their car). 1:1 with monolith L36109+ ready
 *  block. */
export function drawRaceHud(
  ctx: CanvasRenderingContext2D,
  opts: RaceHudOpts,
  rects: RaceHudRects,
): void {
  rects.startCountdown = null;
  rects.forfeit = null;
  rects.dismiss = null;
  // H226: result phase — full-width win/loss banner with payout
  // summary + DISMISS button. 1:1 simplified port of monolith
  // L36109+ result block. The 'wonCarName' / 'lostCarId' opts
  // fields carry the pink-slip handover when stakeType === 'car';
  // otherwise the bet line carries the dollar amount.
  if (opts.phase === 'result') {
    const { GW, GH, winner, bet, wonCarName, lostCarId, pinkSlip } = opts;
    gt2Panel(ctx, 0, GH * 0.18, GW, 150);
    ctx.textAlign = 'center';
    if (winner === 'player') {
      ctx.fillStyle = GT2_COLORS.active;
      ctx.font = 'bold 22px monospace';
      ctx.fillText('YOU WIN', GW / 2, GH * 0.18 + 36);
      ctx.fillStyle = GT2_COLORS.text;
      ctx.font = 'bold 12px monospace';
      if (wonCarName) {
        ctx.fillText('Won: ' + wonCarName, GW / 2, GH * 0.18 + 62);
      } else if (pinkSlip) {
        ctx.fillText('Pink slip claimed', GW / 2, GH * 0.18 + 62);
      } else {
        ctx.fillText('+$' + bet, GW / 2, GH * 0.18 + 62);
      }
      ctx.fillStyle = GT2_COLORS.amberDark;
      ctx.font = '9px monospace';
      ctx.fillText('+4 street rep', GW / 2, GH * 0.18 + 78);
    } else {
      ctx.fillStyle = GT2_COLORS.amberDark;
      ctx.font = 'bold 22px monospace';
      ctx.fillText('YOU LOST', GW / 2, GH * 0.18 + 36);
      ctx.fillStyle = GT2_COLORS.text;
      ctx.font = 'bold 12px monospace';
      if (lostCarId) {
        ctx.fillText('Lost: ' + lostCarId, GW / 2, GH * 0.18 + 62);
      } else if (pinkSlip) {
        ctx.fillText('Pink slip forfeited', GW / 2, GH * 0.18 + 62);
      } else {
        ctx.fillText('-$' + bet, GW / 2, GH * 0.18 + 62);
      }
      ctx.fillStyle = GT2_COLORS.amberDark;
      ctx.font = '9px monospace';
      ctx.fillText('+1 street rep (showed up)', GW / 2, GH * 0.18 + 78);
    }
    // DISMISS button — primary pill.
    const dbX = GW / 2 - 60;
    const dbY = GH * 0.18 + 100;
    const dbW = 120;
    const dbH = 28;
    gt2Pill(ctx, dbX, dbY, dbW, dbH, 'DISMISS', 12, true);
    rects.dismiss = { x: dbX, y: dbY, w: dbW, h: dbH };
    ctx.textAlign = 'left';
    return;
  }

  // H224: countdown phase — big centered 3-2-1-GO! at GH/2.
  // countdown >= 1 → render integer; <1 → render 'GO!'. No
  // interaction (tap-through). Suppression flags don't apply —
  // the countdown is brief and always-visible.
  if (opts.phase === 'countdown') {
    const { GW, GH, countdown } = opts;
    ctx.textAlign = 'center';
    gt2Panel(ctx, GW / 2 - 60, GH / 2 - 36, 120, 72);
    if (countdown >= 1) {
      const n = Math.ceil(countdown);
      ctx.fillStyle = GT2_COLORS.amber;
      ctx.font = 'bold 56px monospace';
      ctx.fillText(String(n), GW / 2, GH / 2 + 18);
    } else {
      ctx.fillStyle = GT2_COLORS.active;
      ctx.font = 'bold 44px monospace';
      ctx.fillText('GO!', GW / 2, GH / 2 + 14);
    }
    ctx.textAlign = 'left';
    return;
  }

  // H225: racing phase — top status bar (20px) with position
  // label + dual progress bars + distance-to-finish line. No
  // interaction. 1:1 with monolith L36109+ racing block.
  if (opts.phase === 'racing') {
    const { GW, GH, px, py, oppX, oppY, startX, startY, finishX, finishY, useMph, TILE } = opts;
    // Progress = 1 - (distance-to-finish / total-distance). Cap
    // to [0, 1] so the bars never overshoot.
    const totalDx = finishX - startX;
    const totalDy = finishY - startY;
    const total = Math.max(1, Math.sqrt(totalDx * totalDx + totalDy * totalDy));
    const pDist = Math.sqrt((finishX - px) ** 2 + (finishY - py) ** 2);
    const oDist = Math.sqrt((finishX - oppX) ** 2 + (finishY - oppY) ** 2);
    const pProg = Math.max(0, Math.min(1, 1 - pDist / total));
    const oProg = Math.max(0, Math.min(1, 1 - oDist / total));
    // Top status bar.
    ctx.fillStyle = 'rgba(18,18,18,0.78)';
    ctx.fillRect(0, 0, GW, 20);
    ctx.fillStyle = pProg > oProg ? GT2_COLORS.active : pProg < oProg ? GT2_COLORS.amberDark : GT2_COLORS.amber;
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      pProg > oProg ? 'YOU LEAD' : pProg < oProg ? 'OPPONENT LEADS' : 'NECK AND NECK',
      GW / 2, 13,
    );
    // Dual progress bars below the status text.
    const barX = 6;
    const barW = GW - 12;
    const barY = 24;
    const barH = 5;
    // Player bar (amber = you).
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = GT2_COLORS.amber;
    ctx.fillRect(barX, barY, Math.round(barW * pProg), barH);
    ctx.strokeStyle = GT2_COLORS.amberDim;
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
    // Opponent bar (dim amber = opponent).
    ctx.fillStyle = GT2_COLORS.bgDeep;
    ctx.fillRect(barX, barY + 7, barW, barH);
    ctx.fillStyle = GT2_COLORS.amberDark;
    ctx.fillRect(barX, barY + 7, Math.round(barW * oProg), barH);
    ctx.strokeStyle = GT2_COLORS.amberDim;
    ctx.strokeRect(barX, barY + 7, barW, barH);
    // Distance-to-finish in the player's preferred unit.
    const distTiles = pDist / TILE;
    let distLabel: string;
    if (useMph) {
      // miles & feet. 1 tile ≈ 0.222m → distMi = distTiles*0.0002271
      // For arcade readout, 1 tile ≈ 1 yard for legibility.
      const distYd = distTiles;
      if (distYd >= 1760) {
        distLabel = (distYd / 1760).toFixed(2) + ' mi';
      } else {
        distLabel = Math.round(distYd * 3) + ' ft';
      }
    } else {
      const distM = distTiles;
      distLabel = distM >= 1000 ? (distM / 1000).toFixed(2) + ' km' : Math.round(distM) + ' m';
    }
    ctx.fillStyle = GT2_COLORS.text;
    ctx.font = 'bold 9px monospace';
    ctx.fillText(distLabel + ' to finish', GW / 2, 44);
    ctx.textAlign = 'left';
    return;
  }

  if (opts.phase !== 'ready') return;
  if (opts.menuOpen || opts.carSelectOpen || opts.fullMapOpen || opts.homeScreenOpen) return;

  const { GW, GH, oppName, bet, pinkSlip } = opts;

  // Dim backdrop centered behind the buttons. Less opaque than
  // the H185-style full-screen modals because the player still
  // wants to SEE the world (they're about to race in it).
  gt2Panel(ctx, 0, GH * 0.18, GW, 130);

  ctx.textAlign = 'center';
  ctx.fillStyle = GT2_COLORS.active;
  ctx.font = 'bold 16px monospace';
  ctx.fillText('READY?', GW / 2, GH * 0.18 + 22);

  ctx.fillStyle = GT2_COLORS.text;
  ctx.font = 'bold 11px monospace';
  ctx.fillText('VS ' + oppName, GW / 2, GH * 0.18 + 42);
  const stakeLine = pinkSlip ? 'PINK SLIP' : '$' + bet + ' bet';
  ctx.fillStyle = pinkSlip ? GT2_COLORS.active : GT2_COLORS.amberDark;
  ctx.font = 'bold 10px monospace';
  ctx.fillText(stakeLine, GW / 2, GH * 0.18 + 58);

  // START COUNTDOWN — primary pill.
  const sbX = GW / 2 - 70;
  const sbY = GH * 0.18 + 70;
  const sbW = 140;
  const sbH = 28;
  gt2Pill(ctx, sbX, sbY, sbW, sbH, 'START COUNTDOWN', 12, true);
  rects.startCountdown = { x: sbX, y: sbY, w: sbW, h: sbH };

  // FORFEIT — secondary pill, smaller.
  const fbX = GW / 2 - 50;
  const fbY = sbY + sbH + 6;
  const fbW = 100;
  const fbH = 22;
  gt2Pill(ctx, fbX, fbY, fbW, fbH, 'FORFEIT', 10, false);
  rects.forfeit = { x: fbX, y: fbY, w: fbW, h: fbH };

  ctx.textAlign = 'left';
}

/** Routes a tap through the rects bag to the right side-effect.
 *  Returns true when consumed. 1:1 with monolith L21717-21727 +
 *  L22135-22147 ready-phase branch (other phases land with their
 *  respective draw branches). */
export function handleRaceHudTap(
  tx: number,
  ty: number,
  rects: RaceHudRects,
  deps: RaceHudDeps,
): boolean {
  const inside = (r: { x: number; y: number; w: number; h: number } | null): boolean =>
    !!r && tx >= r.x && tx <= r.x + r.w && ty >= r.y && ty <= r.y + r.h;
  if (inside(rects.startCountdown)) {
    deps.startCountdown();
    return true;
  }
  if (inside(rects.forfeit)) {
    deps.forfeit();
    return true;
  }
  if (inside(rects.dismiss)) {
    deps.dismissResult();
    return true;
  }
  return false;
}
