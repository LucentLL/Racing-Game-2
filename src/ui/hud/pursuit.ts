/**
 * Pursuit HUD — red meter bar + WANTED label that paints during a
 * police chase. The pursuit STATE is per-cop (TrafficCar.isPursuing
 * + pursuitClockedSpeed + pursuitSlowTime); the gameLoop ticket
 * handler at L1753-L1774 issues a fine when a pursuing cop closes to
 * within 50 wpx of a player slowed below 60 wpx/s.
 *
 * Without this HUD the player saw zero indication they were being
 * chased — flying past a cop at 80 mph just made the cop fall in
 * behind silently, then a ticket landed without warning. The visible
 * "🚔 WANTED" label + escape-progress meter gives the player a
 * cue to slow down before getting clipped.
 *
 * 1:1 inspired by monolith L34450-L34472 — modular adapts the meter
 * to the "escape progress" semantic since the modular pursuit sim
 * doesn't track an arrest-proximity timer yet. The metric exposed is
 * "seconds-of-slowing remaining before pursuit ends" — full meter
 * when the player is still over the limit (no escape progress),
 * empty when they've slowed long enough to end the chase.
 */

import type { TrafficCar } from '@/state/traffic';
import { MPH_TO_WPX } from '@/render/worldMap';

/** Seconds the player must stay under the speed limit before pursuit
 *  ends — mirrors PURSUIT_END_SECS const in src/state/traffic.ts.
 *  Re-declared here so the HUD module doesn't drag the whole traffic
 *  module's internals along. Keep in sync if PURSUIT_END_SECS
 *  changes. */
const HUD_PURSUIT_END_SECS = 3;

/** Return the first cop in the traffic list that's actively pursuing
 *  the player. Multi-cop pile-ons surface only the first; matches the
 *  gameLoop ticket handler's "one ticket per frame max" policy. */
export function findActivePursuer(traffic: ReadonlyArray<TrafficCar>): TrafficCar | null {
  for (const c of traffic) {
    if (c.isCop && c.isPursuing) return c;
  }
  return null;
}

/** Paint the pursuit HUD. No-op when no cop is pursuing. */
export function drawPursuitHud(
  ctx: CanvasRenderingContext2D,
  traffic: ReadonlyArray<TrafficCar>,
  GW: number,
  GH: number,
): void {
  const cop = findActivePursuer(traffic);
  if (!cop) return;

  const meterW = GW * 0.6;
  const meterH = 8;
  const meterX = GW * 0.2;
  const meterY = GH * 0.18;

  // Backdrop band so the label + meter pop on any world background.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
  ctx.fillRect(meterX - 2, meterY - 12, meterW + 4, meterH + 16);

  // Label — "🚔 WANTED — Nmph" using the speed the cop clocked at
  // pursuit-start (mirrors monolith pursuitClockedMph behavior so a
  // player who's now slowed sees the fine-determining speed).
  const clockedMph = Math.round(cop.pursuitClockedSpeed / MPH_TO_WPX);
  ctx.fillStyle = '#f44';
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center';
  const label = clockedMph > 0
    ? '🚔 WANTED — ' + clockedMph + ' mph'
    : '🚔 WANTED';
  ctx.fillText(label, GW / 2, meterY - 4);

  // Escape-progress meter. Fill = 1 - (pursuitSlowTime /
  // PURSUIT_END_SECS) — full red when the player is over the limit
  // (slowTime hasn't accumulated), empty as they brake and slowTime
  // climbs toward 3s end-gate.
  const slowProgress = Math.max(0, Math.min(1, cop.pursuitSlowTime / HUD_PURSUIT_END_SECS));
  const pressure = 1 - slowProgress;
  ctx.fillStyle = '#333';
  ctx.fillRect(meterX, meterY, meterW, meterH);
  // Color gradient red → yellow → green as pressure drops.
  const r = Math.min(255, Math.floor(pressure * 2 * 255));
  const g = Math.min(255, Math.floor((1 - pressure) * 2 * 255));
  ctx.fillStyle = 'rgb(' + r + ',' + g + ',0)';
  ctx.fillRect(meterX, meterY, meterW * pressure, meterH);
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 1;
  ctx.strokeRect(meterX, meterY, meterW, meterH);

  // Hint line — small text under the meter when the player is
  // actively making escape progress, so they know slowing is the
  // right move.
  if (slowProgress > 0.05 && slowProgress < 1) {
    const remaining = Math.max(0, HUD_PURSUIT_END_SECS - cop.pursuitSlowTime);
    ctx.fillStyle = '#aaa';
    ctx.font = '7px monospace';
    ctx.fillText('Keep braking — ' + remaining.toFixed(1) + 's to escape', GW / 2, meterY + meterH + 8);
  } else if (slowProgress <= 0.05) {
    ctx.fillStyle = '#f88';
    ctx.font = '7px monospace';
    ctx.fillText('Slow down to escape', GW / 2, meterY + meterH + 8);
  }
  ctx.textAlign = 'left';
}
