/**
 * Honda Civic 2nd Gen (SL/SR, 1979-1983) — full V2 sprite renderer.
 * The 1500 CX 3-door hatchback.
 *
 * Distinctive features:
 *   - Very small, short, boxy with rounded corners
 *   - SINGLE round sealed-beam headlights per side
 *   - Small vertical rectangular taillights at rear corners
 *   - Flat hood, near-vertical rear hatch
 *
 * Ported from monolith L39595–39752.
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
  ctx.moveTo(-hl, -hw * 0.82);
  ctx.quadraticCurveTo(-hl, -hw * 0.96, -hl + L * 0.04, -hw);
  ctx.lineTo(hl - L * 0.08, -hw);
  ctx.quadraticCurveTo(hl - L * 0.02, -hw * 0.95, hl - L * 0.005, -hw * 0.85);
  ctx.lineTo(hl,             -hw * 0.75);
  ctx.lineTo(hl,              hw * 0.75);
  ctx.lineTo(hl - L * 0.005,  hw * 0.85);
  ctx.quadraticCurveTo(hl - L * 0.02, hw * 0.95, hl - L * 0.08, hw);
  ctx.lineTo(-hl + L * 0.04, hw);
  ctx.quadraticCurveTo(-hl, hw * 0.96, -hl, hw * 0.82);
  ctx.closePath();
}

export const CIVIC_2GEN: GenerationRenderer = {
  id: 'civic_2gen',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.58, 0.54];

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

    // Hood shading + nose center.
    ctx.fillStyle = darken(color, 0.18);
    ctx.fillRect(hl * 0.40, -hw * 0.82, hl * 0.54, hw * 0.18);
    ctx.fillRect(hl * 0.40,  hw * 0.64, hl * 0.54, hw * 0.18);
    ctx.fillStyle = lighten(color, 0.16);
    ctx.fillRect(hl * 0.42, -hw * 0.25, hl * 0.52, hw * 0.50);

    // Rear tailgate body (very small strip).
    ctx.fillStyle = darken(color, 0.14);
    ctx.fillRect(-hl + L * 0.02, -hw * 0.75, L * 0.07, hw * 1.50);

    // Roof.
    ctx.fillStyle = lighten(color, 0.20);
    ctx.fillRect(-hl * 0.70, -hw * 0.80, hl * 0.60, hw * 1.60);

    // Side windows.
    ctx.fillStyle = '#15253e';
    ctx.fillRect(-hl * 0.70, -hw * 0.92, hl * 0.60, hw * 0.12);
    ctx.fillRect(-hl * 0.70,  hw * 0.80, hl * 0.60, hw * 0.12);
    // B-pillar.
    ctx.fillStyle = darken(color, 0.50);
    ctx.fillRect(-hl * 0.40, -hw * 0.94, 0.5, hw * 0.14);
    ctx.fillRect(-hl * 0.40,  hw * 0.80, 0.5, hw * 0.14);

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Front windshield — LARGE.
    const wsBack = -hl * 0.10;
    const wsFront = hl * 0.40;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.52);
    ctx.lineTo(wsFront, -hw * 0.72);
    ctx.lineTo(wsFront,  hw * 0.72);
    ctx.lineTo(wsBack,   hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // Rear windshield — SMALL.
    const rwFront = -hl * 0.70;
    const rwBack  = -hl * 0.86;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(rwBack,  -hw * 0.62);
    ctx.lineTo(rwBack,   hw * 0.62);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = darken(color, 0.48);
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.52); ctx.lineTo(wsFront, -hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.52); ctx.lineTo(wsFront,  hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront, -hw * 0.52); ctx.lineTo(rwBack, -hw * 0.62); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront,  hw * 0.52); ctx.lineTo(rwBack,  hw * 0.62); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(195,220,240,0.55)';
    ctx.fillRect(wsBack + 2.0, -hw * 0.28, (wsFront - wsBack) * 0.3, 0.7);

    // Door seam.
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(-hl * 0.10, -hw * 0.92); ctx.lineTo(-hl * 0.10, hw * 0.92); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.45);
    ctx.fillRect(hl * 0.55, -hw * 0.05, 1.0, 0.7);

    ctx.restore(); // end clip

    // Tiny early-era fender mirrors.
    ctx.fillStyle = darken(color, 0.38);
    ctx.fillRect(hl * 0.36, -hw - 0.9, 1.1, 1.0);
    ctx.fillRect(hl * 0.36,  hw - 0.1, 1.1, 1.0);

    // SINGLE round sealed-beam headlights per side.
    const hlightX = hl - L * 0.04;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.1, 0, Math.PI * 2); ctx.fill();
      const hg = 2.8 + nightFactor * 2.8;
      v2HeadlightGlow(ctx, hlightX, -hw * 0.52, hg, nightFactor * 0.42);
      v2HeadlightGlow(ctx, hlightX,  hw * 0.52, hg, nightFactor * 0.42);
    } else {
      ctx.fillStyle = darken(color, 0.30);
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.1, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.1, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.1, 0, Math.PI * 2); ctx.stroke();
    }

    // Small vertical rectangular taillights at rear corners.
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    ctx.fillRect(tailX, -tw * 0.92, 1.6, tw * 0.40);
    ctx.fillRect(tailX,  tw * 0.52, 1.6, tw * 0.40);
    // Amber.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw * 0.92,        1.2, 0.5);
    ctx.fillRect(tailX,  tw * 0.92 - 0.5,  1.2, 0.5);
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.3 + nightFactor * 1.8 + (isBraking ? 2.2 : 0);
      const ta = isBraking ? 0.50 : nightFactor * 0.32;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      v2TaillightGlow(ctx, tailX + 0.8, -tw * 0.72, tg, ta, tc);
      v2TaillightGlow(ctx, tailX + 0.8,  tw * 0.72, tg, ta, tc);
    }

    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.2, -tw * 0.30, 1.4, 0.8);
      ctx.fillRect(tailX + 0.2,  tw * 0.22, 1.4, 0.8);
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
