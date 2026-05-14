/**
 * Nissan Skyline GT-R R33 (BCNR33, 1995-1998) — full V2 sprite renderer.
 *
 * Distinctive features (vs R34):
 *   - Softer / rounder corners
 *   - Slightly longer, more GT-like proportions
 *   - Twin round headlights per side (R33's are slightly bigger than R34's)
 *   - 4 round taillights per side (same pattern as R34)
 *   - Less pronounced hood bulge
 *   - Smaller rear wing
 *
 * Ported from monolith L39181–39382.
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
  ctx.moveTo(-hl, -hw * 0.60);
  ctx.quadraticCurveTo(-hl, -hw * 0.90, -hl + L * 0.06, -hw * 0.98);
  ctx.lineTo(-hl + L * 0.14, -hw);
  ctx.lineTo(hl - L * 0.16, -hw);
  ctx.quadraticCurveTo(hl - L * 0.08, -hw * 0.96, hl - L * 0.02, -hw * 0.88);
  ctx.lineTo(hl,            -hw * 0.76);
  ctx.lineTo(hl,             hw * 0.76);
  ctx.lineTo(hl - L * 0.02,  hw * 0.88);
  ctx.quadraticCurveTo(hl - L * 0.08, hw * 0.96, hl - L * 0.16, hw);
  ctx.lineTo(-hl + L * 0.14, hw);
  ctx.lineTo(-hl + L * 0.06, hw * 0.98);
  ctx.quadraticCurveTo(-hl, hw * 0.90, -hl, hw * 0.60);
  ctx.closePath();
}

export const GTR_R33: GenerationRenderer = {
  id: 'gtr_r33',

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

    // Rear deck.
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.06, -hw * 0.72, hl * 0.58, hw * 1.44);

    // Hood edges.
    ctx.fillStyle = darken(color, 0.20);
    ctx.fillRect(hl * 0.14, -hw * 0.76, hl * 0.78, hw * 0.12);
    ctx.fillRect(hl * 0.14,  hw * 0.64, hl * 0.78, hw * 0.12);

    // Hood center.
    ctx.fillStyle = lighten(color, 0.18);
    ctx.fillRect(hl * 0.16, -hw * 0.22, hl * 0.76, hw * 0.44);

    // Roof.
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.22, -hw * 0.50, hl * 0.44, hw * 1.00);

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Windshield.
    const wsBack = hl * 0.08;
    const wsFront = hl * 0.24;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsFront, -hw * 0.44);
    ctx.lineTo(wsFront,  hw * 0.44);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.closePath();
    ctx.fill();

    // Rear window.
    const rwFront = -hl * 0.08;
    const rwBack  = -hl * 0.32;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.54);
    ctx.lineTo(rwBack,  -hw * 0.42);
    ctx.lineTo(rwBack,   hw * 0.42);
    ctx.lineTo(rwFront,  hw * 0.54);
    ctx.closePath();
    ctx.fill();

    // Roof panel.
    ctx.fillStyle = lighten(color, 0.10);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(wsBack,  -hw * 0.56);
    ctx.lineTo(wsBack,   hw * 0.56);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // A-pillars.
    ctx.strokeStyle = darken(color, 0.50);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.56); ctx.lineTo(wsFront, -hw * 0.42); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.56); ctx.lineTo(wsFront,  hw * 0.42); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 0.5, -hw * 0.22, (wsFront - wsBack) * 0.5, 0.6);

    // Subtle hood ridge (R33 less aggressive than R34).
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(hl * 0.30, -hw * 0.08); ctx.lineTo(hl * 0.85, -hw * 0.08); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(hl * 0.30,  hw * 0.08); ctx.lineTo(hl * 0.85,  hw * 0.08); ctx.stroke();

    // Door seams.
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.92); ctx.lineTo(hl * 0.06,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.30, -hw * 0.92); ctx.lineTo(-hl * 0.30,  hw * 0.92); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.60, -hw * 0.04, 1.0, 0.7);

    ctx.restore();

    // Mirrors.
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.10, -hw - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.10,  hw - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.10 + 0.3, -hw - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.10 + 0.3,  hw,        0.7, 0.5);

    // Headlights — twin round per side (R33 style — slightly larger).
    const hlightX = hl - L * 0.04;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.beginPath(); ctx.arc(hlightX - 0.4, -hw * 0.62, 1.0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.9, -hw * 0.62, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.4,  hw * 0.62, 1.0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.9,  hw * 0.62, 0.9, 0, Math.PI * 2); ctx.fill();
      const hg = 2.8 + nightFactor * 2.8;
      v2HeadlightGlow(ctx, hlightX - 1.1, -hw * 0.62, hg, nightFactor * 0.4);
      v2HeadlightGlow(ctx, hlightX - 1.1,  hw * 0.62, hg, nightFactor * 0.4);
    } else {
      ctx.fillStyle = darken(color, 0.28);
      ctx.beginPath(); ctx.arc(hlightX - 0.4, -hw * 0.62, 1.0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.9, -hw * 0.62, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.4,  hw * 0.62, 1.0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 1.9,  hw * 0.62, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.arc(hlightX - 0.4, s * hw * 0.62, 1.0, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.arc(hlightX - 1.9, s * hw * 0.62, 0.9, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // 4-round taillights per side (same pattern as R34).
    const tailX = -hl + L * 0.04;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    const lampR = 0.85;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 0.6), lampR,        0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 0.6), lampR,        0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 0.6, s * (tw - 2.5), lampR * 0.85, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tailX + 2.0, s * (tw - 2.5), lampR * 0.85, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = color;
    ctx.fillRect(tailX + 0.2, -tw * 0.20, 2.4, tw * 0.40);
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX - 0.2, -tw - 0.2, 1.0, 0.5);
    ctx.fillRect(tailX - 0.2,  tw - 0.3, 1.0, 0.5);
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.0 + (isBraking ? 2.5 : 0);
      const ta = isBraking ? 0.50 : nightFactor * 0.32;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      for (const s of [-1, 1]) {
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 0.6), tg,       ta,       tc);
        v2TaillightGlow(ctx, tailX + 1.3, s * (tw - 2.5), tg * 0.9, ta * 0.9, tc);
      }
    }

    // Rear wing (body color, smaller than R34's).
    ctx.fillStyle = darken(color, 0.45);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.68, 1.5, hw * 1.36);
    ctx.fillStyle = lighten(color, 0.04);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.68, 0.4, hw * 1.36);
    ctx.fillStyle = darken(color, 0.65);
    ctx.fillRect(-hl - 0.1, -hw * 0.70, 0.4, hw * 0.14);
    ctx.fillRect(-hl - 0.1,  hw * 0.56, 0.4, hw * 0.14);

    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -0.8, 2.0, 1.6);
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
