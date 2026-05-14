/**
 * Traffic-cop visuals (TRAFFIC COP job). Draws:
 *   - Blue radar fan in front of the player when parked in 'radar' phase.
 *   - Alternating blue/white roof light bar on the player's car when a
 *     speeder is detected, during chase, or after a bump.
 *   - Pulsing red ring + far-away arrow indicator around the target car.
 *
 * Ported from render() L31949–32021 of the v8.99.126.89 monolith. Only
 * runs when LIFE.copJob is active AND LIFE.playerJob === 'TRAFFIC COP'.
 */

import type { FrameView } from './types';

export type CopPhase = 'radar' | 'chasing' | 'bumped' | string;

export interface CopJobState {
  phase: CopPhase;
  /** Index into the traffic[] array of the currently-flagged speeder. -1
   *  if none flagged yet. */
  targetIdx: number;
  /** Set by update() when a speeder enters the radar cone — the player
   *  must press ACCEPT to begin the chase. -1 if no alert. */
  alertCarIdx: number;
}

export interface CopTrafficCar {
  x: number;
  y: number;
  _despawned?: boolean;
}

export interface TrafficCopDeps {
  TILE: number;
  /** The cop job record. drawTrafficCop short-circuits if absent. */
  copJob: CopJobState | null;
  /** True when LIFE.playerJob === 'TRAFFIC COP'. */
  playerIsTrafficCop: boolean;
  /** Player draw position (= drawX / drawY in the monolith). */
  drawX: number;
  drawY: number;
  pAngle: number;
  /** |pSpeed|<2 = parked, gates the radar fan. */
  pSpeed: number;
  /** Traffic array — only the entry at cj.targetIdx is read. */
  traffic: ReadonlyArray<CopTrafficCar>;
}

export function drawTrafficCop(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  deps: TrafficCopDeps,
): void {
  if (!deps.copJob || !deps.playerIsTrafficCop) return;
  const { TILE, copJob: cj, drawX, drawY, pAngle, pSpeed, traffic } = deps;
  const playerStopped = Math.abs(pSpeed) < 2;
  ctx.save();

  // ---- Blue radar fan (parked in radar phase) ----------------------------
  if (cj.phase === 'radar' && playerStopped) {
    const beamLen = TILE * 25;
    const beamAngle = 0.26; // ~15° half-angle
    const frontX = drawX + Math.cos(pAngle) * 12;
    const frontY = drawY + Math.sin(pAngle) * 12;
    const pulse = 0.12 + Math.sin(Date.now() * 0.003) * 0.06;
    const grd = ctx.createRadialGradient(
      frontX, frontY, 0,
      frontX + Math.cos(pAngle) * beamLen * 0.5,
      frontY + Math.sin(pAngle) * beamLen * 0.5,
      beamLen,
    );
    grd.addColorStop(0, `rgba(0,120,255,${pulse + 0.1})`);
    grd.addColorStop(0.5, `rgba(0,80,255,${pulse * 0.5})`);
    grd.addColorStop(1, 'rgba(0,40,255,0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.moveTo(frontX, frontY);
    ctx.lineTo(frontX + Math.cos(pAngle - beamAngle) * beamLen,
               frontY + Math.sin(pAngle - beamAngle) * beamLen);
    ctx.lineTo(frontX + Math.cos(pAngle + beamAngle) * beamLen,
               frontY + Math.sin(pAngle + beamAngle) * beamLen);
    ctx.closePath();
    ctx.fill();
  }

  // ---- Alternating blue/white light bar (player car roof) ----------------
  const copLightsOn = (cj.phase === 'radar' && cj.alertCarIdx >= 0)
                    || cj.phase === 'chasing'
                    || cj.phase === 'bumped';
  if (copLightsOn) {
    const flash = Math.floor(Date.now() / 120) % 4;
    const lbW = 3;
    const lbH = 8;
    ctx.save();
    ctx.translate(drawX, drawY);
    ctx.rotate(pAngle);
    if (flash < 2) {
      ctx.fillStyle = '#0066ff';
      ctx.fillRect(-lbW / 2, -lbH / 2, lbW, lbH / 2);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-lbW / 2, 0, lbW, lbH / 2);
    } else {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-lbW / 2, -lbH / 2, lbW, lbH / 2);
      ctx.fillStyle = '#0066ff';
      ctx.fillRect(-lbW / 2, 0, lbW, lbH / 2);
    }
    ctx.globalAlpha = 0.2;
    ctx.fillStyle = flash < 2 ? '#4488ff' : '#88aaff';
    ctx.fillRect(-lbW / 2 - 2, -lbH / 2 - 2, lbW + 4, lbH + 4);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  // ---- Target-car highlight + far-away arrow indicator -------------------
  if ((cj.phase === 'chasing' || cj.phase === 'bumped')
      && cj.targetIdx >= 0 && cj.targetIdx < traffic.length) {
    const t = traffic[cj.targetIdx];
    if (!t._despawned) {
      const pulse2 = 2 + Math.sin(Date.now() * 0.008) * 1.5;
      ctx.strokeStyle = '#ff2200';
      ctx.lineWidth = pulse2;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(t.x, t.y, 12, 0, Math.PI * 2);
      ctx.stroke();
      const tdx = t.x - drawX;
      const tdy = t.y - drawY;
      const tDist = Math.sqrt(tdx * tdx + tdy * tdy);
      if (tDist > TILE * 8) {
        const aAng = Math.atan2(tdy, tdx);
        const aX = drawX + Math.cos(aAng) * 40;
        const aY = drawY + Math.sin(aAng) * 40;
        ctx.fillStyle = '#ff2200';
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.moveTo(aX + Math.cos(aAng) * 6,        aY + Math.sin(aAng) * 6);
        ctx.lineTo(aX + Math.cos(aAng + 2.5) * 5,  aY + Math.sin(aAng + 2.5) * 5);
        ctx.lineTo(aX + Math.cos(aAng - 2.5) * 5,  aY + Math.sin(aAng - 2.5) * 5);
        ctx.closePath();
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  ctx.restore();
}
