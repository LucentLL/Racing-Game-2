/**
 * drawTrafficTrailer — renders an AI traffic vehicle's trailer body. Two
 * variants: 'tanker' (cylindrical with bands + catwalk) and 'box' (van
 * with corrugated sides). Includes X-Ray Body mode support and night-
 * dependent taillight glow.
 *
 * Distinct from src/render/trailer.ts (which draws the PLAYER'S 53'
 * trailer at full detail). Traffic trailers are smaller, simpler, and
 * use the traffic-car's color rather than a typed TrailerType.
 *
 * Ported from monolith L36563–36654.
 */

import type { FrameView } from '../types';

/** AI traffic car carrying a tTrailer. */
export interface TrafficCarWithTrailer {
  x: number;
  y: number;
  angle: number;
  tTrailer: TrafficTrailer;
}

/** Traffic trailer payload — slimmer than the player's TrailerState. */
export interface TrafficTrailer {
  length: number;
  width: number;
  /** Articulated heading. null = follow tractor's angle. */
  angle: number | null;
  /** 'tanker' selects the cylindrical body; anything else = box trailer. */
  type: string;
  /** Trailer paint. Box trailers fill the body; tanker is fixed gray with
   *  this color only used for the front frame rail. */
  color: string;
}

export interface TrafficTrailerDeps {
  /** Night factor 0..1 — drives taillight glow alpha. The caller computes
   *  the same _nf as the player passes use; null lets the trailer compute
   *  its own from LIFE.hour when no global is available. */
  nf: number;
  /** X-Ray Body mode (LIFE.gameplaySettings.xrayBody). */
  xrayBody: boolean;
}

export function drawTrafficTrailer(
  ctx: CanvasRenderingContext2D,
  _view: FrameView,
  car: TrafficCarWithTrailer,
  deps: TrafficTrailerDeps,
): void {
  const tr = car.tTrailer;
  const fwX = car.x - Math.cos(car.angle) * 6;
  const fwY = car.y - Math.sin(car.angle) * 6;
  const trAng = tr.angle != null ? tr.angle : car.angle;
  const trCX = fwX - Math.cos(trAng) * (tr.length / 2);
  const trCY = fwY - Math.sin(trAng) * (tr.length / 2);

  ctx.save();
  ctx.translate(trCX, trCY);
  ctx.rotate(trAng);

  const tL = tr.length;
  const tW = tr.width;
  const tHL = tL / 2;
  const tHW = tW / 2;
  const xray = deps.xrayBody;

  // Shadow (skip in xray).
  if (!xray) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fillRect(-tHL + 1, -tHW + 1, tL, tW);
  }

  // Tandem-axle dual tires.
  ctx.fillStyle = xray ? '#ff0' : '#111';
  const dtDia = 4.5;
  const dtSW = xray ? 2 : 1.4;
  const dtGp = 0.3;
  const dtIn = 0.3;
  for (const ax of [-tHL + 8, -tHL + 14]) {
    ctx.fillRect(ax, -tHW + dtIn, dtDia, dtSW);
    ctx.fillRect(ax, -tHW + dtIn + dtSW + dtGp, dtDia, dtSW);
    ctx.fillRect(ax,  tHW - dtIn - dtSW, dtDia, dtSW);
    ctx.fillRect(ax,  tHW - dtIn - dtSW * 2 - dtGp, dtDia, dtSW);
  }

  if (xray) {
    // X-Ray: dashed cyan outline only.
    ctx.strokeStyle = 'rgba(0,255,255,0.35)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([2, 2]);
    if (tr.type === 'tanker') {
      const tankR = tHW * 0.85;
      const tankFL = tHL - tankR;
      ctx.beginPath();
      ctx.moveTo(-tankFL, -tankR);
      ctx.lineTo( tankFL, -tankR);
      ctx.arc( tankFL, 0, tankR, -Math.PI / 2,  Math.PI / 2);
      ctx.lineTo(-tankFL, tankR);
      ctx.arc(-tankFL, 0, tankR,  Math.PI / 2,  Math.PI * 1.5);
      ctx.closePath();
      ctx.stroke();
    } else {
      ctx.strokeRect(-tHL, -tHW, tL, tW);
    }
    ctx.setLineDash([]);
  } else if (tr.type === 'tanker') {
    // Tanker: gray frame + cylindrical body in trailer paint + bands.
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(-tHL, -tHW * 0.4, tL, tW * 0.4);
    const tankR = tHW * 0.85;
    const tankFL = tHL - tankR;
    ctx.fillStyle = tr.color;
    ctx.beginPath();
    ctx.moveTo(-tankFL, -tankR);
    ctx.lineTo( tankFL, -tankR);
    ctx.arc( tankFL, 0, tankR, -Math.PI / 2,  Math.PI / 2);
    ctx.lineTo(-tankFL, tankR);
    ctx.arc(-tankFL, 0, tankR,  Math.PI / 2,  Math.PI * 1.5);
    ctx.closePath();
    ctx.fill();
    // Top reflection band.
    ctx.fillStyle = '#e0e0e0';
    ctx.fillRect(-tankFL, -tankR * 0.45, tankFL * 2, tankR * 0.35);
    // Circumferential bands.
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 0.5;
    for (let i = -tHL + 7; i < tHL - 3; i += 5) {
      ctx.beginPath();
      ctx.moveTo(i, -tHW * 0.8);
      ctx.lineTo(i,  tHW * 0.8);
      ctx.stroke();
    }
  } else {
    // Box trailer: solid color body + corrugated lines + edge accents.
    ctx.fillStyle = tr.color;
    ctx.fillRect(-tHL, -tHW, tL, tW);
    ctx.strokeStyle = 'rgba(0,0,0,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = -tHL + 6; i < tHL - 4; i += 5) {
      ctx.beginPath();
      ctx.moveTo(i, -tHW);
      ctx.lineTo(i,  tHW);
      ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    ctx.fillRect(-tHL, -tHW, tL, 1);
    ctx.fillRect(-tHL,  tHW - 1, tL, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fillRect(-tHL, -tHW, 2, tW);
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(-tHL + 1, -tHW);
    ctx.lineTo(-tHL + 1,  tHW);
    ctx.stroke();
  }

  // Taillight pixels + halo at night.
  ctx.fillStyle = deps.nf > 0.05 ? '#ff3300' : '#aa0000';
  ctx.fillRect(-tHL, -tHW, 1.5, 1.5);
  ctx.fillRect(-tHL,  tHW - 1.5, 1.5, 1.5);
  if (deps.nf > 0.05) {
    const ttR = 2 + deps.nf * 4;
    for (const ts of [-1, 1]) {
      const ty = ts * (tHW - 0.75);
      const tg = ctx.createRadialGradient(-tHL, ty, 0, -tHL, ty, ttR);
      tg.addColorStop(0, `rgba(255,30,0,${deps.nf * 0.35})`);
      tg.addColorStop(1, 'rgba(255,30,0,0)');
      ctx.fillStyle = tg;
      ctx.fillRect(-tHL - ttR, ty - ttR, ttR * 2, ttR * 2);
    }
  }

  ctx.restore();
}
