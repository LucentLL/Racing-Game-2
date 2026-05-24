/**
 * Road info HUD — small widget below the minimap showing what road
 * the player is on + its speed limit. Highway shields (interstate
 * blue/red badge or US white square) render before the name when
 * applicable. Background flashes red translucent when the player is
 * 10+ mph over the limit.
 *
 * Without this widget the player has no in-game cue for the road
 * name or speed limit; both data sources (playerRoadInfoAt +
 * playerSpeedLimitWpx) have been ported since H175/H166 but the
 * read-out never landed.
 *
 * 1:1 port of monolith L33858-L33923 inside the minimap render block.
 * Modular adapts the anchor to the minimap's actual position
 * (MINIMAP_SIZE + MINIMAP_PADDING) instead of the monolith's
 * mmX+mmW+mmY math which used different anchors.
 */

import type { PlayerState } from '@/state/player';
import { playerRoadInfoAt, playerSpeedLimitWpx, MPH_TO_WPX } from '@/render/worldMap';
import { MINIMAP_SIZE } from '@/render/minimap';

/** MINIMAP_PADDING isn't exported from minimap.ts; re-declare so the
 *  anchor math stays single-sourced even if the minimap module's
 *  internal constant moves. */
const MINIMAP_PADDING = 8;

/** Paint the widget. No-op when the player is far enough from any
 *  road that playerRoadInfoAt returns null (e.g. off-road on grass). */
export function drawRoadInfo(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  useMph: boolean,
): void {
  const info = playerRoadInfoAt(player.px, player.py);
  if (!info) return;
  const limitWpx = playerSpeedLimitWpx(player.px, player.py);
  // Convert to mph for the sign + comparison. wpx/s → mph divides
  // by MPH_TO_WPX (the existing constant from worldMap).
  const limitMph = Math.round(limitWpx / MPH_TO_WPX);

  // Anchor below the minimap at the same left edge.
  const mmX = MINIMAP_PADDING;
  const mmY = MINIMAP_PADDING;
  const mmW = MINIMAP_SIZE;
  const rnY = mmY + MINIMAP_SIZE + 4;
  const rnH = 16;

  // Backdrop band so the text reads on any world background.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.fillRect(mmX - 1, rnY, mmW + 2, rnH);

  const name = info.name;
  const isInterstate = name.startsWith('I-');
  const isUS = name.startsWith('US-');
  const shX = mmX + 2;
  const shY = rnY + 1;

  // Shield icon — interstate gets the blue/red US-spec shield
  // approximation; US-highway gets a plain white square. Other
  // roads render with no shield.
  if (isInterstate) {
    ctx.fillStyle = '#00c';
    ctx.beginPath();
    ctx.moveTo(shX, shY + 1);
    ctx.lineTo(shX + 10, shY + 1);
    ctx.lineTo(shX + 11, shY + 3);
    ctx.lineTo(shX + 9, shY + 10);
    ctx.lineTo(shX + 5, shY + 12);
    ctx.lineTo(shX + 1, shY + 10);
    ctx.lineTo(shX - 1, shY + 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#c00';
    ctx.fillRect(shX + 1, shY + 1, 9, 3);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 5px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name.replace('I-', ''), shX + 5, shY + 9);
  } else if (isUS) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(shX, shY + 1, 12, 10);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 5px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(name.replace('US-', ''), shX + 6, shY + 8);
  }

  // Road name — left-aligned past the shield (or past the left
  // edge with no shield).
  const nameX = mmX + (isInterstate || isUS ? 16 : 4);
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(name, nameX, rnY + 12);
  const nameW = ctx.measureText(name).width;

  // Speed limit sign — white square, black "LIMIT" label up top,
  // bold mph number below. Doesn't render the unit suffix to match
  // the monolith's compact rendering at L33903-L33909.
  const slX = nameX + nameW + 3;
  const slY = rnY + 1;
  ctx.fillStyle = '#fff';
  ctx.fillRect(slX, slY, 14, 12);
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 1;
  ctx.strokeRect(slX, slY, 14, 12);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 4px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('LIMIT', slX + 7, slY + 4);
  ctx.font = 'bold 6px monospace';
  ctx.fillText(String(limitMph), slX + 7, slY + 11);
  ctx.textAlign = 'left';

  // Red translucent overlay when the player is 10+ mph over the
  // posted limit. Mirrors monolith L33915-L33922 — uses ground-truth
  // pSpeed not analog dispSpeed so wheel spin during a burnout
  // doesn't trip the flash.
  const speedMph = useMph
    ? Math.abs(player.pSpeed) / MPH_TO_WPX
    : Math.abs(player.pSpeed) / MPH_TO_WPX; // mph either way for the gate
  const gpsMph = Math.floor(speedMph);
  if (gpsMph > limitMph) {
    const overBy = gpsMph - limitMph;
    if (overBy >= 10) {
      ctx.fillStyle = 'rgba(255, 0, 0, 0.3)';
      ctx.fillRect(mmX - 1, rnY, mmW + 2, rnH);
    }
  }
}
