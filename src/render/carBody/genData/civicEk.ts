/**
 * Honda Civic EK (6th Gen, 1995-2000) — full V2 sprite renderer.
 * The EK9 Type R — B16B VTEC legend.
 *
 * Distinctive features (vs EG):
 *   - Slightly longer, less bubble, more refined silhouette
 *   - Multi-reflector projector headlights with visible lens dot
 *   - Body-color bumpers
 *   - Subtle rear spoiler (Type R signature)
 *   - Slightly larger rectangular taillights
 *
 * Ported from monolith L40156–40343.
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
  ctx.moveTo(-hl, -hw * 0.66);
  ctx.quadraticCurveTo(-hl, -hw * 0.92, -hl + L * 0.05, -hw * 0.98);
  ctx.lineTo(-hl + L * 0.12, -hw);
  ctx.lineTo(hl - L * 0.16, -hw);
  ctx.quadraticCurveTo(hl - L * 0.06, -hw * 0.96, hl - L * 0.02, -hw * 0.86);
  ctx.quadraticCurveTo(hl + 0.1, -hw * 0.56, hl + 0.1, -hw * 0.34);
  ctx.lineTo(hl + 0.2, -hw * 0.14);
  ctx.lineTo(hl + 0.2,  hw * 0.14);
  ctx.lineTo(hl + 0.1,  hw * 0.34);
  ctx.quadraticCurveTo(hl + 0.1, hw * 0.56, hl - L * 0.02, hw * 0.86);
  ctx.quadraticCurveTo(hl - L * 0.06, hw * 0.96, hl - L * 0.16, hw);
  ctx.lineTo(-hl + L * 0.12, hw);
  ctx.lineTo(-hl + L * 0.05, hw * 0.98);
  ctx.quadraticCurveTo(-hl, hw * 0.92, -hl, hw * 0.66);
  ctx.closePath();
}

export const CIVIC_EK: GenerationRenderer = {
  id: 'civic_ek',

  render(ctx, L, W, color, opts) {
    const hl = L / 2;
    const hw = W / 2;
    const { isBraking, nightFactor, isReverse, steerAngle, isXray } = opts;
    const axle: readonly [number, number] = [0.60, 0.54];

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

    ctx.fillStyle = darken(color, 0.16);
    ctx.fillRect(hl * 0.40, -hw * 0.82, hl * 0.54, hw * 0.18);
    ctx.fillRect(hl * 0.40,  hw * 0.64, hl * 0.54, hw * 0.18);
    ctx.fillStyle = lighten(color, 0.20);
    ctx.fillRect(hl * 0.42, -hw * 0.25, hl * 0.52, hw * 0.50);

    ctx.fillStyle = darken(color, 0.15);
    ctx.fillRect(-hl + L * 0.02, -hw * 0.75, L * 0.07, hw * 1.50);

    // Roof.
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.70, -hw * 0.80, hl * 0.60, hw * 1.60);

    // Side windows + B-pillar.
    ctx.fillStyle = '#15253e';
    ctx.fillRect(-hl * 0.70, -hw * 0.92, hl * 0.60, hw * 0.12);
    ctx.fillRect(-hl * 0.70,  hw * 0.80, hl * 0.60, hw * 0.12);
    ctx.fillStyle = darken(color, 0.50);
    ctx.fillRect(-hl * 0.40, -hw * 0.94, 0.5, hw * 0.14);
    ctx.fillRect(-hl * 0.40,  hw * 0.80, 0.5, hw * 0.14);

    // Rear haunch highlights.
    ctx.strokeStyle = lighten(color, 0.20);
    ctx.lineWidth = 0.7;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.10, s * hw * 0.96);
      ctx.quadraticCurveTo(-hl + L * 0.22, s * hw * 0.98, -hl + L * 0.32, s * hw * 0.94);
      ctx.stroke();
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // Front windshield — LARGE.
    const wsBack = -hl * 0.10;
    const wsFront = hl * 0.40;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.48);
    ctx.lineTo(wsFront, -hw * 0.72);
    ctx.lineTo(wsFront,  hw * 0.72);
    ctx.lineTo(wsBack,   hw * 0.48);
    ctx.closePath();
    ctx.fill();

    // Rear windshield — SMALL.
    const rwFront = -hl * 0.70;
    const rwBack  = -hl * 0.86;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.48);
    ctx.lineTo(rwBack,  -hw * 0.60);
    ctx.lineTo(rwBack,   hw * 0.60);
    ctx.lineTo(rwFront,  hw * 0.48);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.48); ctx.lineTo(wsFront, -hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.48); ctx.lineTo(wsFront,  hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront, -hw * 0.48); ctx.lineTo(rwBack, -hw * 0.60); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront,  hw * 0.48); ctx.lineTo(rwBack,  hw * 0.60); ctx.stroke();

    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 2.0, -hw * 0.25, (wsFront - wsBack) * 0.3, 0.7);

    ctx.strokeStyle = darken(color, 0.32);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(-hl * 0.10, -hw * 0.92); ctx.lineTo(-hl * 0.10, hw * 0.92); ctx.stroke();

    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.55, -hw * 0.05, 1.0, 0.7);

    ctx.restore();

    // Mirrors.
    ctx.fillStyle = darken(color, 0.38);
    ctx.fillRect(hl * 0.16, -hw - 1.0, 1.3, 1.1);
    ctx.fillRect(hl * 0.16,  hw - 0.1, 1.3, 1.1);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.16 + 0.3, -hw - 0.8, 0.65, 0.5);
    ctx.fillRect(hl * 0.16 + 0.3,  hw + 0.1, 0.65, 0.5);

    // EK signature: projector-inside-rectangle headlights.
    const hlightX = hl - L * 0.02;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX - 2.0, -hw * 0.60, 2.2, hw * 0.22);
      ctx.fillRect(hlightX - 2.0,  hw * 0.38, 2.2, hw * 0.22);
      // Projector lens center.
      ctx.fillStyle = '#ddd8a8';
      ctx.beginPath(); ctx.arc(hlightX - 0.9, -hw * 0.49, 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.9,  hw * 0.49, 0.45, 0, Math.PI * 2); ctx.fill();
      const hg = 3.0 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX - 0.9, -hw * 0.49, hg, nightFactor * 0.45);
      v2HeadlightGlow(ctx, hlightX - 0.9,  hw * 0.49, hg, nightFactor * 0.45);
    } else {
      ctx.fillStyle = darken(color, 0.28);
      ctx.fillRect(hlightX - 2.0, -hw * 0.60, 2.2, hw * 0.22);
      ctx.fillRect(hlightX - 2.0,  hw * 0.38, 2.2, hw * 0.22);
      ctx.strokeStyle = lighten(color, 0.25);
      ctx.lineWidth = 0.3;
      ctx.strokeRect(hlightX - 2.0, -hw * 0.60, 2.2, hw * 0.22);
      ctx.strokeRect(hlightX - 2.0,  hw * 0.38, 2.2, hw * 0.22);
      // Projector lens dark dot.
      ctx.fillStyle = '#1a1a1a';
      ctx.beginPath(); ctx.arc(hlightX - 0.9, -hw * 0.49, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.9,  hw * 0.49, 0.4, 0, Math.PI * 2); ctx.fill();
    }

    // EK taillights — slightly larger than EG, more refined.
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    ctx.fillRect(tailX, -tw * 0.92, 2.2, tw * 0.40);
    ctx.fillRect(tailX,  tw * 0.52, 2.2, tw * 0.40);
    // Internal divider (brake / running).
    ctx.fillStyle = darken(tlBright, 0.5);
    ctx.fillRect(tailX, -tw * 0.72,        2.2, 0.35);
    ctx.fillRect(tailX,  tw * 0.72 - 0.35, 2.2, 0.35);
    // Amber at outer corner.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw * 0.92,        1.3, 0.5);
    ctx.fillRect(tailX,  tw * 0.92 - 0.5,  1.3, 0.5);
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.0 + (isBraking ? 2.5 : 0);
      const ta = isBraking ? 0.52 : nightFactor * 0.34;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      v2TaillightGlow(ctx, tailX + 1.1, -tw * 0.72, tg, ta, tc);
      v2TaillightGlow(ctx, tailX + 1.1,  tw * 0.72, tg, ta, tc);
    }

    // Type R signature subtle rear spoiler.
    ctx.fillStyle = darken(color, 0.42);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.72, 1.3, hw * 1.44);
    ctx.fillStyle = lighten(color, 0.05);
    ctx.fillRect(-hl + L * 0.01, -hw * 0.72, 0.4, hw * 1.44);

    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -tw * 0.22, 1.8, 1.0);
      ctx.fillRect(tailX + 0.3,  tw * 0.12, 1.8, 1.0);
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
