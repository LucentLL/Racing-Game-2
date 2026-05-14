/**
 * Tow-truck visuals. Two flavors:
 *
 *   1. PLAYER TOW JOB — when the player is driving a tow truck and a job is
 *      active. Animates the broken car sliding from the ground onto the
 *      flatbed with a winch cable, then tie-down straps + hazard flashers
 *      once fully loaded.
 *
 *   2. AI INCOMING TOW — when the player's own car is broken and the
 *      reverse happens: an AI tow truck approaches, reverses, and winches
 *      the player's car onto its bed.
 *
 * Ported from render() L32023–32144 of the v8.99.126.89 monolith. Both
 * flavors call drawTopCar() (the player + traffic body renderer landing in
 * C19), so this module receives that as a dependency.
 */

import type { FrameView } from './types';

/** drawTopCar signature lifted from the monolith. Matches the call sites
 *  at L32051, L32064, L32090, L32113, L32128. */
export type DrawTopCarFn = (
  x: number,
  y: number,
  angle: number,
  color: string,
  isPlayer: boolean,
  steerAngle: number,
  bodyType: string | undefined,
  isCop: boolean,
  copType: string | undefined,
  brakingOrEbrk: boolean,
  bikeSpriteKey?: string | undefined,
) => void;

/** Player's active tow job (when LIFE.playerJob === 'TOW DRIVER' and
 *  a job is on the bed / being loaded). */
export interface PlayerTowJob {
  /** 0..1 — how far the car has slid up the ramp. >=1 = on the bed. */
  towLoadProgress: number;
  /** True once the car is on the bed and being transported. */
  hooked?: boolean;
  /** World-space angle of the broken car at pickup time. */
  towCarAngle: number;
  towCarColor: string;
  towCarBody: string;
}

/** AI-driven tow truck that arrives to recover the player's broken car. */
export interface IncomingTow {
  x: number;
  y: number;
  angle: number;
  /** 'arriving' | 'reversing' | 'loading' | 'departing'. */
  phase: 'arriving' | 'reversing' | 'loading' | 'departing' | string;
  /** Stalled car's world position. Used as winch origin during loading. */
  playerCarX?: number;
  playerCarY?: number;
  /** 0..1 loading animation progress. */
  loadProg: number;
}

export interface TowDeps {
  /** Player tow job, if active. */
  towJob: PlayerTowJob | null;
  /** AI tow truck, if dispatched. */
  incomingTow: IncomingTow | null;
  /** Player's car size [length, width] — used for bed offset + winch math. */
  carSize: readonly [number, number];
  /** Player's car color (for the on-bed render in the AI-tow phase). */
  playerCarColor: string;
  /** Player draw position. */
  drawX: number;
  drawY: number;
  pAngle: number;
  /** Body renderer (C19). */
  drawTopCar: DrawTopCarFn;
}

export function drawTow(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: TowDeps,
): void {
  drawPlayerTowJob(ctx, deps);
  drawIncomingTow(ctx, deps);
}

function drawPlayerTowJob(
  ctx: CanvasRenderingContext2D,
  deps: TowDeps,
): void {
  const tj = deps.towJob;
  if (!tj) return;
  if (tj.towLoadProgress <= 0 && !tj.hooked) return;
  const { drawX, drawY, pAngle, carSize, drawTopCar } = deps;
  const prog = tj.towLoadProgress || 1;

  // Bed center sits at L*0.14 behind truck center (matches the Tow-Truck-
  // White sprite's bed position, see v8.99.122.41 buffer correction).
  const bedOff = carSize[0] * 0.14;
  const bedX = drawX - Math.cos(pAngle) * bedOff;
  const bedY = drawY - Math.sin(pAngle) * bedOff;
  // Pickup point: car sits one rear-length behind the truck on the ground.
  const rearDist = carSize[0] * 0.6;
  const groundX = drawX - Math.cos(pAngle) * rearDist;
  const groundY = drawY - Math.sin(pAngle) * rearDist;
  const towX = groundX + (bedX - groundX) * prog;
  const towY = groundY + (bedY - groundY) * prog;

  // Lerp angle from broken-car road angle to truck angle.
  let angleDiff = pAngle - tj.towCarAngle;
  while (angleDiff >  Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
  const carAng = tj.towCarAngle + angleDiff * prog;

  if (prog < 1) {
    // Still loading — draw car at interpolated ramp position.
    drawTopCar(towX, towY, carAng, tj.towCarColor, false, 0, tj.towCarBody, false, undefined, false);
    // Winch cable from truck rear to car front.
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    const cableStartX = drawX - Math.cos(pAngle) * (carSize[0] * 0.45);
    const cableStartY = drawY - Math.sin(pAngle) * (carSize[0] * 0.45);
    ctx.beginPath();
    ctx.moveTo(cableStartX, cableStartY);
    ctx.lineTo(towX, towY);
    ctx.stroke();
    ctx.setLineDash([]);
    // Loading progress bar above the truck.
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(drawX - 15, drawY - carSize[1] - 8, 30, 5);
    ctx.fillStyle = '#0f0';
    ctx.fillRect(drawX - 14, drawY - carSize[1] - 7, 28 * prog, 3);
  } else {
    // Fully loaded — car ON the bed, with tie-down straps + hazard flashers.
    drawTopCar(bedX, bedY, pAngle, tj.towCarColor, false, 0, tj.towCarBody, false, undefined, false);
    ctx.save();
    ctx.translate(bedX, bedY);
    ctx.rotate(pAngle);
    const carL = 21;
    const carW = 8.5;
    ctx.strokeStyle = '#cc9900';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(-carL * 0.2, -carW * 0.45); ctx.lineTo(-carL * 0.3, -carW * 0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-carL * 0.2,  carW * 0.45); ctx.lineTo(-carL * 0.3,  carW * 0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( carL * 0.2, -carW * 0.45); ctx.lineTo( carL * 0.3, -carW * 0.7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo( carL * 0.2,  carW * 0.45); ctx.lineTo( carL * 0.3,  carW * 0.7); ctx.stroke();
    ctx.restore();
    // Amber hazard flashers (rear corners) — strobe at ~1 Hz.
    if (Math.floor(Date.now() / 500) % 2 === 0) {
      const hazOff = carSize[0] * 0.45;
      const hx = drawX - Math.cos(pAngle) * hazOff;
      const hy = drawY - Math.sin(pAngle) * hazOff;
      ctx.fillStyle = '#ff8800';
      ctx.globalAlpha = 0.7;
      ctx.fillRect(hx + Math.cos(pAngle + Math.PI / 2) * 4 - 1,
                   hy + Math.sin(pAngle + Math.PI / 2) * 4 - 1, 2, 2);
      ctx.fillRect(hx - Math.cos(pAngle + Math.PI / 2) * 4 - 1,
                   hy - Math.sin(pAngle + Math.PI / 2) * 4 - 1, 2, 2);
      ctx.globalAlpha = 1;
    }
  }
}

function drawIncomingTow(
  ctx: CanvasRenderingContext2D,
  deps: TowDeps,
): void {
  const it = deps.incomingTow;
  if (!it) return;
  const { drawTopCar, playerCarColor } = deps;

  // 1. Tow truck body (vendor color is fixed at #e8c840).
  drawTopCar(it.x, it.y, it.angle, '#e8c840', false, 0, 'towtruck', false, undefined, false);

  // 2. During loading: draw the player's car being winched on.
  if (it.phase === 'loading') {
    // v8.99.122.41 buffer-corrected offsets: bedOff=5.4, ground fallback=31,
    // winch cable origin=26 — all rescaled for the L=38.5 sprite-based
    // towtruck. Match the monolith exactly.
    const bedOff = 5.4;
    const groundX = typeof it.playerCarX === 'number' ? it.playerCarX : it.x - Math.cos(it.angle) * 31;
    const groundY = typeof it.playerCarY === 'number' ? it.playerCarY : it.y - Math.sin(it.angle) * 31;
    const bedX = it.x - Math.cos(it.angle) * bedOff;
    const bedY = it.y - Math.sin(it.angle) * bedOff;
    const lx = groundX + (bedX - groundX) * it.loadProg;
    const ly = groundY + (bedY - groundY) * it.loadProg;
    // isPlayer=true so the towed body renders at CAR().size with the
    // player's exact body/bike shape (v8.99.94 fix for Kawasaki Ninja
    // showing as a green sedan).
    drawTopCar(lx, ly, it.angle, playerCarColor, true, 0, undefined, false, undefined, false);
    // Loading progress bar.
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(it.x - 15, it.y - 12, 30, 5);
    ctx.fillStyle = '#0f0';
    ctx.fillRect(it.x - 14, it.y - 11, 28 * it.loadProg, 3);
    // Winch cable from truck's rear axle to the car being winched.
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(it.x - Math.cos(it.angle) * 26, it.y - Math.sin(it.angle) * 26);
    ctx.lineTo(lx, ly);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 3. Departing: car on bed, same model + size as on the ground.
  if (it.phase === 'departing') {
    const bedX = it.x - Math.cos(it.angle) * 5.4;
    const bedY = it.y - Math.sin(it.angle) * 5.4;
    drawTopCar(bedX, bedY, it.angle, playerCarColor, true, 0, undefined, false, undefined, false);
  }

  // 4. Amber flashers (always on while AI tow is on-screen).
  if (Math.floor(Date.now() / 400) % 2 === 0) {
    const hw2 = 5;
    for (const s of [-1, 1]) {
      ctx.fillStyle = '#ff8800';
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(it.x + Math.cos(it.angle + Math.PI / 2) * hw2 * s,
              it.y + Math.sin(it.angle + Math.PI / 2) * hw2 * s,
              1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // 5. Status text above the truck.
  ctx.fillStyle = '#ff0';
  ctx.font = 'bold 5px monospace';
  ctx.textAlign = 'center';
  const statusText = it.phase === 'arriving'  ? 'TOW TRUCK COMING'
                   : it.phase === 'reversing' ? 'POSITIONING...'
                   : it.phase === 'loading'   ? 'LOADING...'
                   :                            'TOWING AWAY';
  ctx.fillText(statusText, it.x, it.y - 16);
  ctx.textAlign = 'left';
}
