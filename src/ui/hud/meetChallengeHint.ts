/**
 * H1034: CAR MEET "CHALLENGE" hint — a pulsing button that appears when the
 * player rolls up near-stopped beside a parked car at the meet. Tapping it (or
 * clicking on desktop) starts a drag race against THAT specific car.
 *
 * Same shape as the home-entry hint (src/ui/hud/homeHint.ts): a per-frame
 * proximity tick sets a flag on LIFE, a draw pass renders the pulsing button
 * while the flag is set, and a hit-test lets the click router fire the action.
 * Here the flag also carries WHICH car (its catalog id + name).
 */
import { TILE } from '@/config/world/tiles';
import { getParkedCars } from '@/world/parkedCars';
import type { LifeState } from '@/state/life';

/** Roll up this slow (wpx/s) to arm a challenge — deliberate, not a drive-by. */
const CHALLENGE_MAX_SPEED = 6;
/** Challenge radius² — a ~2.4-tile reach so pulling up next to a car fires. */
const CHALLENGE_R2 = (TILE * 2.4) * (TILE * 2.4);

/** Per-frame proximity update. Sets life._meetChallengeId/_meetChallengeName to
 *  the NEAREST parked car in range when the player is near-stopped and nothing
 *  blocks it; clears otherwise. `blocked` = any overlay open; `raceActive` =
 *  a track race is already armed/running (don't offer a new challenge then). */
export function tickMeetChallenge(
  life: LifeState,
  playerPx: number,
  playerPy: number,
  playerSpeed: number,
  blocked: boolean,
  raceActive: boolean,
): void {
  if (blocked || raceActive || Math.abs(playerSpeed) > CHALLENGE_MAX_SPEED) {
    life._meetChallengeId = undefined;
    life._meetChallengeName = undefined;
    return;
  }
  const cars = getParkedCars();
  let bestId: string | undefined;
  let bestName: string | undefined;
  let bestD2 = CHALLENGE_R2;
  for (const c of cars) {
    const dx = c.x - playerPx, dy = c.y - playerPy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; bestId = c.id; bestName = c.name; }
  }
  life._meetChallengeId = bestId;
  life._meetChallengeName = bestName;
}

/** Hit-test box for the CHALLENGE button (HUD canvas coords). Shared by the
 *  renderer + click router so they agree on the rect. */
export function meetChallengeHintRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  const w = 240;
  return { x: GW / 2 - w / 2, y: GH * 0.18, w, h: 30 };
}

/** Draw the pulsing CHALLENGE button when a target is set and nothing blocks
 *  it. No-op otherwise. Hot-amber to read as "race", distinct from the cyan
 *  ENTER HOME hint. */
export function drawMeetChallengeHint(
  ctx: CanvasRenderingContext2D,
  life: LifeState,
  GW: number,
  GH: number,
  blocked: boolean,
): void {
  if (blocked || !life._meetChallengeId) return;
  const hb = Math.sin(Date.now() * 0.006) > 0;
  if (!hb) return;
  const { x, y, w, h } = meetChallengeHintRect(GW, GH);
  ctx.fillStyle = 'rgba(255, 140, 40, 0.22)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(255, 160, 60, 1)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255, 200, 120, 0.98)';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  const name = life._meetChallengeName ?? 'this car';
  ctx.fillText(`⚡ CHALLENGE ${name}`, GW / 2, y + 20);
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

/** Hit-test helper for the click router. Caller also checks that
 *  _meetChallengeId is set this frame (button actually visible). */
export function isMeetChallengeHit(tx: number, ty: number, GW: number, GH: number): boolean {
  const { x, y, w, h } = meetChallengeHintRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
