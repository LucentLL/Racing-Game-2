/**
 * Nissan Skyline GT-R R32 (BNR32, 1989-1994) — full V2 sprite renderer.
 *
 * Distinctive features:
 *   - Compact and angular 2-door coupe (smaller than R33 / R34)
 *   - Rectangular quad headlights (square pairs per side — not round)
 *   - 4 round taillights per side (original of the iconic pattern)
 *   - Smaller rear wing
 *   - Boxier early-90s proportions
 *
 * Ported from monolith L39393–39583.
 */

import type { GenerationRenderer } from '../types';
import { v2GroundShadow, v2Wheels, v2TaillightGlow, v2HeadlightGlow } from '../v2Helpers';
import { darken, lighten } from '../colorUtils';

function tracePath(
  ctx: CanvasRenderingContext2D,
  hl: number,
  hw: number,
  L: number,
  _W: number,
): void {
  ctx.beginPath();
  ctx.moveTo(-hl, -hw * 0.75);
  ctx.lineTo(-hl + L * 0.02, -hw * 0.94);
  ctx.lineTo(-hl + L * 0.08, -hw);
  ctx.lineTo(hl - L * 0.14, -hw);
  ctx.lineTo(hl - L * 0.04, -hw * 0.96);
  ctx.lineTo(hl - L * 0.005, -hw * 0.88);
  ctx.lineTo(hl,             -hw * 0.78);
  ctx.lineTo(hl,              hw * 0.78);
  ctx.lineTo(hl - L * 0.005,  hw * 0.88);
  ctx.lineTo(hl - L * 0.04,   hw * 0.96);
  ctx.lineTo(hl - L * 0.14,   hw);
  ctx.lineTo(-hl + L * 0.08,  hw);
  ctx.lineTo(-hl + L * 0.02,  hw * 0.94);
  ctx.lineTo(-hl,             hw * 0.75);
  ctx.closePath();
}

export const GTR_R32: GenerationRenderer = {
  id: 'gtr_r32',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.58, 0.52];

    if (!isXray) v2GroundShadow(ctx, tracePath, hl, hw, L, W);
    v2Wheels(ctx, axle, hl, hw, L, steerAngle, isXray);

    if (isXray) {
      ctx.save();
      tracePath(ctx, hl, hw, L, W);
      ctx.strokeStyle = 'rgba(0,255,255,0.35)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([2, 2]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.fillStyle = color;
    ctx.fill();

    ctx.save();
    tracePath(ctx, hl, hw, L, W);
    ctx.clip();

    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.03, -hw * 0.80, hl * 0.62, hw * 1.60);

    ctx.fillStyle = darken(color, 0.20);
    ctx.fillRect(hl * 0.10, -hw * 0.80, hl * 0.82, hw * 0.14);
    ctx.fillRect(hl * 0.10,  hw * 0.66, hl * 0.82, hw * 0.14);

    ctx.fillStyle = lighten(color, 0.16);
    ctx.fillRect(hl * 0.12, -hw * 0.18, hl * 0.80, hw * 0.36);

    ctx.fillStyle = lighten(color, 0.20);
    ctx.fillRect(-hl * 0.22, -hw * 0.48, hl * 0.40, hw * 0.96);

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Windshield (R32 more vertical/upright than R34).
    const wsBack = hl * 0.10;
    const wsFront = hl * 0.22;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.60);
    ctx.lineTo(wsFront, -hw * 0.48);
    ctx.lineTo(wsFront,  hw * 0.48);
    ctx.lineTo(wsBack,   hw * 0.60);
    ctx.closePath();
    ctx.fill();

    const rwFront = -hl * 0.06;
    const rwBack  = -hl * 0.32;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.56);
    ctx.lineTo(rwBack,  -hw * 0.44);
    ctx.lineTo(rwBack,   hw * 0.44);
    ctx.lineTo(rwFront,  hw * 0.56);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = lighten(color, 0.08);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.54);
    ctx.lineTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.lineTo(rwFront,  hw * 0.54);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.58); ctx.lineTo(wsFront, -hw * 0.46); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.58); ctx.lineTo(wsFront,  hw * 0.46); ctx.stroke();

    ctx.fillStyle = 'rgba(195,220,240,0.55)';
    ctx.fillRect(wsBack + 0.4, -hw * 0.24, (wsFront - wsBack) * 0.5, 0.6);

    // Boxy panel seams.
    ctx.strokeStyle = darken(color, 0.38);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.15, 0);          ctx.lineTo(hl * 0.90, 0);          ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.92); ctx.lineTo(hl * 0.06,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.30, -hw * 0.92); ctx.lineTo(-hl * 0.30,  hw * 0.92); ctx.stroke();

    ctx.fillStyle = lighten(color, 0.48);
    ctx.fillRect(hl * 0.55, -hw * 0.04, 1.0, 0.7);

    ctx.restore();

    // Mirrors (older style, smaller).
    ctx.fillStyle = darken(color, 0.38);
    ctx.fillRect(hl * 0.22, -hw - 1.0, 1.3, 1.2);
    ctx.fillRect(hl * 0.22,  hw - 0.2, 1.3, 1.2);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.22 + 0.3, -hw - 0.8, 0.7, 0.5);
    ctx.fillRect(hl * 0.22 + 0.3,  hw,        0.7, 0.5);

    // R32 rectangular quad headlights (signature — stacked pairs per side).
    const hlightX = hl - L * 0.04;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX - 1.4, -hw * 0.68, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4, -hw * 0.50, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4,  hw * 0.34, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4,  hw * 0.52, 1.7, hw * 0.16);
      const hg = 2.5 + nightFactor * 2.5;
      v2HeadlightGlow(ctx, hlightX - 0.6, -hw * 0.60, hg, nightFactor * 0.42);
      v2HeadlightGlow(ctx, hlightX - 0.6,  hw * 0.60, hg, nightFactor * 0.42);
    } else {
      ctx.fillStyle = darken(color, 0.30);
      ctx.fillRect(hlightX - 1.4, -hw * 0.68, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4, -hw * 0.50, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4,  hw * 0.34, 1.7, hw * 0.16);
      ctx.fillRect(hlightX - 1.4,  hw * 0.52, 1.7, hw * 0.16);
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.strokeRect(hlightX - 1.4, -hw * 0.68, 1.7, hw * 0.16);
      ctx.strokeRect(hlightX - 1.4, -hw * 0.50, 1.7, hw * 0.16);
      ctx.strokeRect(hlightX - 1.4,  hw * 0.34, 1.7, hw * 0.16);
      ctx.strokeRect(hlightX - 1.4,  hw * 0.52, 1.7, hw * 0.16);
    }

    // 4-round taillights per side (original of the GT-R legacy pattern).
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    const lampR = 0.80;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 0.5), lampR,       0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 0.5), lampR,       0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 2.3), lampR * 0.8, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 2.3), lampR * 0.8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillRect(tailX + 0.2, -tw * 0.18, 2.4, tw * 0.36);
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw - 0.2, 1.0, 0.5);
    ctx.fillRect(tailX,  tw - 0.3, 1.0, 0.5);
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.3 + nightFactor * 2.0 + (isBraking ? 2.3 : 0);
      const ta = isBraking ? 0.50 : nightFactor * 0.32;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 0.5), tg,       ta,       tc);
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 2.3), tg * 0.9, ta * 0.9, tc);
      }
    }

    // Small rear wing (R32 had less aggressive wing than R33/R34).
    ctx.fillStyle = darken(color, 0.45);
    ctx.fillRect(-hl + L * 0.005, -hw * 0.58, 1.2, hw * 1.16);
    ctx.fillStyle = lighten(color, 0.04);
    ctx.fillRect(-hl + L * 0.005, -hw * 0.58, 0.3, hw * 1.16);

    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -0.7, 2.0, 1.4);
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
