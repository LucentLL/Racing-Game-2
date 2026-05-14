/**
 * Honda Civic EG (5th Gen, 1991-1995) — full V2 sprite renderer.
 * The iconic EG6 hatchback ("jellybean" bubble shape).
 *
 * Distinctive features:
 *   - Rounded bubble silhouette (heavy use of quadratic curves)
 *   - Long horizontal multi-reflector headlights (EG signature)
 *   - Small rectangular taillights at rear corners
 *   - Smooth flush body panels, short nose, wider cabin
 *
 * Ported from monolith L39941–40142.
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
  ctx.moveTo(-hl, -hw * 0.62);
  ctx.quadraticCurveTo(-hl, -hw * 0.92, -hl + L * 0.06, -hw * 0.98);
  ctx.quadraticCurveTo(-hl + L * 0.12, -hw, -hl + L * 0.20, -hw);
  ctx.lineTo(hl - L * 0.16, -hw);
  ctx.quadraticCurveTo(hl - L * 0.06, -hw * 0.96, hl - L * 0.02, -hw * 0.84);
  ctx.quadraticCurveTo(hl + 0.1, -hw * 0.55, hl + 0.1, -hw * 0.30);
  ctx.quadraticCurveTo(hl + 0.2, -hw * 0.12, hl + 0.2, 0);
  ctx.quadraticCurveTo(hl + 0.2, hw * 0.12, hl + 0.1, hw * 0.30);
  ctx.quadraticCurveTo(hl + 0.1, hw * 0.55, hl - L * 0.02, hw * 0.84);
  ctx.quadraticCurveTo(hl - L * 0.06, hw * 0.96, hl - L * 0.16, hw);
  ctx.lineTo(-hl + L * 0.20, hw);
  ctx.quadraticCurveTo(-hl + L * 0.12, hw, -hl + L * 0.06, hw * 0.98);
  ctx.quadraticCurveTo(-hl, hw * 0.92, -hl, hw * 0.62);
  ctx.closePath();
}

export const CIVIC_EG: GenerationRenderer = {
  id: 'civic_eg',

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

    // Hood shading + nose center.
    ctx.fillStyle = darken(color, 0.16);
    ctx.fillRect(hl * 0.40, -hw * 0.82, hl * 0.54, hw * 0.18);
    ctx.fillRect(hl * 0.40,  hw * 0.64, hl * 0.54, hw * 0.18);
    ctx.fillStyle = lighten(color, 0.20);
    ctx.fillRect(hl * 0.42, -hw * 0.25, hl * 0.52, hw * 0.50);

    // Rear tailgate body.
    ctx.fillStyle = darken(color, 0.15);
    ctx.fillRect(-hl + L * 0.02, -hw * 0.75, L * 0.07, hw * 1.50);

    // Roof / cabin panel.
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.70, -hw * 0.80, hl * 0.60, hw * 1.60);

    // Side windows.
    ctx.fillStyle = '#15253e';
    ctx.fillRect(-hl * 0.70, -hw * 0.92, hl * 0.60, hw * 0.12);
    ctx.fillRect(-hl * 0.70,  hw * 0.80, hl * 0.60, hw * 0.12);
    // B-pillar.
    ctx.fillStyle = darken(color, 0.50);
    ctx.fillRect(-hl * 0.40, -hw * 0.94, 0.5, hw * 0.14);
    ctx.fillRect(-hl * 0.40,  hw * 0.80, 0.5, hw * 0.14);

    // Rear haunch highlights.
    ctx.strokeStyle = lighten(color, 0.22);
    ctx.lineWidth = 0.8;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-hl + L * 0.08, s * hw * 0.94);
      ctx.quadraticCurveTo(-hl + L * 0.18, s * hw * 0.96, -hl + L * 0.28, s * hw * 0.92);
      ctx.stroke();
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
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

    // A-pillar / C-pillar lines.
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(wsBack, -hw * 0.48); ctx.lineTo(wsFront, -hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack,  hw * 0.48); ctx.lineTo(wsFront,  hw * 0.72); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront, -hw * 0.48); ctx.lineTo(rwBack, -hw * 0.60); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(rwFront,  hw * 0.48); ctx.lineTo(rwBack,  hw * 0.60); ctx.stroke();

    // Glint.
    ctx.fillStyle = 'rgba(200,225,245,0.60)';
    ctx.fillRect(wsBack + 2.0, -hw * 0.25, (wsFront - wsBack) * 0.3, 0.7);

    // Door seams.
    ctx.strokeStyle = darken(color, 0.32);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(-hl * 0.10, -hw * 0.92); ctx.lineTo(-hl * 0.10, hw * 0.92); ctx.stroke();

    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.55, -hw * 0.05, 1.0, 0.7);

    ctx.restore();

    // Mirrors (body color).
    ctx.fillStyle = darken(color, 0.38);
    ctx.fillRect(hl * 0.18, -hw - 1.0, 1.2, 1.1);
    ctx.fillRect(hl * 0.18,  hw - 0.1, 1.2, 1.1);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.18 + 0.3, -hw - 0.8, 0.6, 0.45);
    ctx.fillRect(hl * 0.18 + 0.3,  hw + 0.1, 0.6, 0.45);

    // EG signature: long horizontal multi-reflector headlights.
    const hlightX = hl - L * 0.02;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.fillRect(hlightX - 2.2, -hw * 0.58, 2.4, hw * 0.18);
      ctx.fillRect(hlightX - 2.2,  hw * 0.40, 2.4, hw * 0.18);
      const hg = 3.0 + nightFactor * 2.8;
      v2HeadlightGlow(ctx, hlightX - 1.0, -hw * 0.49, hg, nightFactor * 0.44);
      v2HeadlightGlow(ctx, hlightX - 1.0,  hw * 0.49, hg, nightFactor * 0.44);
    } else {
      ctx.fillStyle = darken(color, 0.28);
      ctx.fillRect(hlightX - 2.2, -hw * 0.58, 2.4, hw * 0.18);
      ctx.fillRect(hlightX - 2.2,  hw * 0.40, 2.4, hw * 0.18);
      ctx.strokeStyle = lighten(color, 0.25);
      ctx.lineWidth = 0.3;
      ctx.strokeRect(hlightX - 2.2, -hw * 0.58, 2.4, hw * 0.18);
      ctx.strokeRect(hlightX - 2.2,  hw * 0.40, 2.4, hw * 0.18);
      // Multi-reflector segment dividers.
      ctx.beginPath(); ctx.moveTo(hlightX - 1.4, -hw * 0.58); ctx.lineTo(hlightX - 1.4, -hw * 0.40); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(hlightX - 1.4,  hw * 0.40); ctx.lineTo(hlightX - 1.4,  hw * 0.58); ctx.stroke();
    }

    // Small rectangular corner taillights.
    const tailX = -hl + L * 0.02;
    const tw = hw * 0.82;
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    ctx.fillRect(tailX, -tw * 0.92, 2.0, tw * 0.36);
    ctx.fillRect(tailX,  tw * 0.56, 2.0, tw * 0.36);
    // Amber.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(tailX, -tw * 0.92,        1.3, 0.5);
    ctx.fillRect(tailX,  tw * 0.92 - 0.5,  1.3, 0.5);
    if (isBraking || nightFactor > 0.05) {
      const tg = 2.5 + nightFactor * 2.0 + (isBraking ? 2.5 : 0);
      const ta = isBraking ? 0.52 : nightFactor * 0.34;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      v2TaillightGlow(ctx, tailX + 1.0, -tw * 0.74, tg, ta, tc);
      v2TaillightGlow(ctx, tailX + 1.0,  tw * 0.74, tg, ta, tc);
    }

    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(tailX + 0.3, -tw * 0.20, 1.6, 0.9);
      ctx.fillRect(tailX + 0.3,  tw * 0.12, 1.6, 0.9);
    }

    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
