/**
 * Live physics debug HUD — opt-in panel showing internal player state
 * so the player (or a dev tweaking physMuBase / physDriftEnterThresh
 * from the OPT PHYSICS TUNING block) can see numbers update in real
 * time. Toggled via OPT → Debug HUD (life.gameplaySettings.
 * physDebugHUD).
 *
 * Without this widget the OPT panel's Debug HUD toggle had nowhere to
 * land — third dead toggle from H560 after H578 scanlines + H579 FPS.
 *
 * Layout: 76px-wide panel anchored at the left edge below the minimap
 * + road-info widget. Two-column rows: bold label / right-aligned
 * value. Values that come from the Phase 0B integrator show '---'
 * when phase0B isn't initialized (player on legacy arcade path,
 * ineligible car, or low-speed branch). 1:1 inspired by monolith
 * L34095-L34153 simplified to fields modular's PlayerState actually
 * carries.
 *
 * Cost: ~30 fillText calls per frame when the toggle is on, zero
 * when off (the entry guard short-circuits). Negligible on any
 * modern device.
 */

import type { PlayerState } from '@/state/player';
import { MINIMAP_SIZE } from '@/render/minimap';

const MINIMAP_PADDING = 8;

/** Format a signed number with N decimals and explicit '+' for
 *  positives — makes deltas read consistently in a fixed-width font. */
function fmtSigned(n: number, decimals: number = 1): string {
  const sign = n >= 0 ? '+' : '';
  return sign + n.toFixed(decimals);
}

const RAD2DEG = 180 / Math.PI;

/** Paint the debug HUD. No-op when the toggle is off. */
export function drawPhysicsDebug(
  ctx: CanvasRenderingContext2D,
  player: PlayerState,
  enabled: boolean,
): void {
  if (!enabled) return;
  const p0 = player.phase0B;
  const live0B = p0 !== undefined;

  // Derived values not directly on PlayerState.
  const wSpd = live0B
    ? Math.sqrt(p0.pVx * p0.pVx + p0.pVy * p0.pVy)
    : 0;
  let slipAngNow = 0;
  if (live0B) {
    slipAngNow = player.pAngle - Math.atan2(p0.pVy, p0.pVx);
    while (slipAngNow > Math.PI) slipAngNow -= 2 * Math.PI;
    while (slipAngNow < -Math.PI) slipAngNow += 2 * Math.PI;
  }

  const rows: Array<[string, string]> = [
    ['pSpd', fmtSigned(player.pSpeed, 1)],
    ['wSpd', live0B ? fmtSigned(wSpd, 1) : '---'],
    ['yawR', live0B ? fmtSigned(p0.pYawRate * RAD2DEG, 0) + '°/s' : '---'],
    ['slip', live0B ? fmtSigned(slipAngNow * RAD2DEG, 0) + '°' : '---'],
    ['gear', String(player.prevGear)],
    ['rpm',  String(Math.round(player.pRpm))],
    ['eBrT', live0B ? fmtSigned(p0.pEbrakeTimer, 2) : '---'],
    ['pDft', live0B ? fmtSigned(p0.pDrift, 2) : fmtSigned(player.slipAngle, 2)],
    ['dft?', (live0B ? p0.pDrifting : player.drifting) ? 'YES' : 'no'],
    ['rev?', player.pRevIntent ? 'YES' : 'no'],
    ['ws',   fmtSigned(player.wheelspinRatio, 2)],
    ['wGap', fmtSigned(player.wheelGap, 1)],
    ['lyrZ', String(player.layerZ)],
    ['path', live0B ? '0B' : 'arcade'],
  ];

  const panelW = 76;
  const rowH = 9;
  const panelH = rows.length * rowH + 4;
  // Anchor below the road-info widget under the minimap. Minimap
  // bottom = MINIMAP_PADDING + MINIMAP_SIZE; road info adds ~20px;
  // give 4px breathing room.
  const dX = 2;
  const dY = MINIMAP_PADDING + MINIMAP_SIZE + 24;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
  ctx.fillRect(dX, dY, panelW, panelH);
  ctx.strokeStyle = '#0ff';
  ctx.lineWidth = 1;
  ctx.strokeRect(dX + 0.5, dY + 0.5, panelW - 1, panelH - 1);
  ctx.font = 'bold 7px monospace';
  for (let i = 0; i < rows.length; i++) {
    const yy = dY + 3 + i * rowH + 6;
    ctx.fillStyle = '#8cf';
    ctx.textAlign = 'left';
    ctx.fillText(rows[i][0], dX + 3, yy);
    ctx.fillStyle = '#0ff';
    ctx.textAlign = 'right';
    ctx.fillText(rows[i][1], dX + panelW - 3, yy);
  }
  ctx.textAlign = 'left';
}
