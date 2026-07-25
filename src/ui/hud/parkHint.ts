/**
 * H1238: PARK / START ENGINE prompt — pulsing amber bar.
 *
 * Appears when the player has rolled to a stop on a parking surface (a
 * lot, a driveway, or their own garage notch) and offers to shut the
 * engine off; with the engine already off it flips to START ENGINE.
 *
 * Same 4-part contract as every other drive-state prompt (tick → rect →
 * draw → hit-test), modelled on ui/hud/homeHint.ts. Sits at GH*0.26 —
 * the free band between the car-meet challenge bar (0.18) and the
 * view-pin prompt (0.35).
 */

/** Speed below which the car reads as parked. Matches GARAGE_PARK_SPEED
 *  and the gas-pump "rolled to a stop" convention (both 3 wpx/s). */
export const PARK_MAX_SPEED = 3;

/** Tick-shaped LIFE slot. */
export interface ParkHintLife {
  engineOff?: boolean;
  /** Starter is cranking — the bar shows a non-actionable STARTING… so
   *  the player gets feedback instead of an unchanged button they feel
   *  compelled to re-press. */
  _engineStarting?: boolean;
  _parkHint?: boolean;
}

/** Parking surfaces in the baked tile map. 18 = parking lot asphalt,
 *  19 = parking lot concrete AND driveways AND the garage-notch floor
 *  (the editor palette overloads 19 three ways — all three are places
 *  it makes sense to shut the engine off, so the overload is harmless
 *  here). See editor/stamp.ts palette docs. */
export function isParkableTile(tile: number): boolean {
  return tile === 18 || tile === 19;
}

export function parkHintRect(GW: number, GH: number): {
  x: number; y: number; w: number; h: number;
} {
  // y 0.60 sits below every other drive prompt (home 0.12, building
  // 0.12+30, meet 0.18, pin 0.35, tow 0.42, cop 0.50). The 0.50+32 floor
  // keeps it clear of the cop bar on very short landscape viewports,
  // where fraction-only bands collide (a 320px-tall phone gave the
  // original 0.26 band a 9px overlap with the ENTER-building bar, and
  // this bar's tap route would have stolen it).
  return {
    x: GW / 2 - 78,
    y: Math.max(GH * 0.6, GH * 0.5 + 32),
    w: 156,
    h: 24,
  };
}

/** Per-frame gate. `parkable` = standing on a parking surface or inside
 *  the home garage slot; `stopped` = |pSpeed| < PARK_MAX_SPEED. With the
 *  engine already off the prompt stays up regardless of surface so the
 *  player can always restart (they may have been pushed, or the save
 *  resumed them somewhere odd). */
export function tickParkHint(
  life: ParkHintLife,
  parkable: boolean,
  stopped: boolean,
  blocked: boolean,
): void {
  if (blocked) {
    life._parkHint = false;
    return;
  }
  life._parkHint = life.engineOff ? true : (parkable && stopped);
}

export function drawParkHint(
  ctx: CanvasRenderingContext2D,
  life: ParkHintLife,
  GW: number,
  GH: number,
  blocked: boolean,
): void {
  if (!life._parkHint || blocked) return;
  // Cranking: steady (not blinking) STARTING… — feedback that the press
  // landed, and visibly not a button.
  if (life._engineStarting) {
    const { x, y, w, h } = parkHintRect(GW, GH);
    ctx.fillStyle = 'rgba(200, 200, 200, 0.18)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(220, 220, 220, 0.7)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = 'rgba(240, 240, 240, 0.9)';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('STARTING…', GW / 2, y + 16);
    ctx.textAlign = 'left';
    ctx.lineWidth = 1;
    return;
  }
  const hb = Math.sin(Date.now() * 0.005) > 0;
  if (!hb) return;
  const off = !!life.engineOff;
  const { x: bx, y: by, w: bw, h: bh } = parkHintRect(GW, GH);
  ctx.fillStyle = off ? 'rgba(120, 220, 90, 0.25)' : 'rgba(240, 170, 60, 0.25)';
  ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = off ? '#78dc5a' : '#f0aa3c';
  ctx.lineWidth = 2;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = off ? 'rgba(160, 255, 130, 0.95)' : 'rgba(255, 210, 120, 0.95)';
  ctx.font = 'bold 11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(off ? '🔑 START ENGINE  (P)' : '🅿 PARK · ENGINE OFF  (P)', GW / 2, by + 16);
  ctx.textAlign = 'left';
  ctx.lineWidth = 1;
}

export function isParkHintHit(
  tx: number,
  ty: number,
  GW: number,
  GH: number,
): boolean {
  const { x, y, w, h } = parkHintRect(GW, GH);
  return tx >= x && tx <= x + w && ty >= y && ty <= y + h;
}
