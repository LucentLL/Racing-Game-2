/**
 * H67 — gear indicator overlay inside the tachometer dial.
 *
 * Big bold digit (1-5) or "N" sitting in the center of the tach, matching
 * the dashboard convention of sport-car interiors (RX-7, Supra A80, Skyline
 * R32-R34) where the gear indicator lives at the tach's optical center.
 *
 * Stateless speed-bracket mapping — the same proxy strategy H66 uses for
 * RPM. Real shift transitions (with cooldown, manual rev-limit cut, auto-
 * shift hysteresis) live in physics/gearAndRpm.ts as a scaffold; once that
 * gets wired into arcadeUpdate, drawGearIndicator should switch to reading
 * player.pGear directly instead of bracketing on speed.
 *
 * Painted AFTER drawTachometer so the digit sits on top of the needle
 * sweep. A small dark backdrop circle ensures the digit reads cleanly
 * even when the needle passes through.
 */

const SPEED_MAX = 200;          // matches arcadeUpdate MAX_SPEED + H64/H66

/** Speed-bracket → gear. Brackets chosen so each gear covers a similar
 *  RPM band given H66's linear RPM/speed proxy. */
function gearFromSpeed(speed: number): string {
  if (speed < 1) return 'N';
  if (speed < 30) return '1';
  if (speed < 65) return '2';
  if (speed < 105) return '3';
  if (speed < 150) return '4';
  return '5';
}

/** Paint the gear digit inside the tachometer dial. Position math mirrors
 *  drawTachometer in tachometer.ts — keep in sync if tach geometry moves. */
export function drawGearIndicator(
  ctx: CanvasRenderingContext2D,
  hudW: number,
  hudH: number,
  speed: number,
): void {
  // Tach center, recomputed from the same formula in tachometer.ts.
  const TACH_OUTER = 32;
  const cx = hudW - 56 - 90 - 84;
  const cy = hudH - TACH_OUTER - 28;

  // Backdrop circle so the digit reads through the needle. Slightly larger
  // than the digit's footprint, fully opaque dark fill.
  ctx.fillStyle = 'rgba(8, 8, 14, 0.92)';
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 220, 220, 0.4)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // Big gear digit. Color shifts red at top gear so the player has a hint
  // they're maxed out and shifts cap there.
  const gear = gearFromSpeed(speed);
  ctx.fillStyle = gear === '5'
    ? '#ff8866'
    : gear === 'N'
      ? '#8aa'
      : '#fff';
  ctx.font = 'bold 14px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(gear, cx, cy + 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

/** Exported for tests when they land. */
export const _internal = { gearFromSpeed };
