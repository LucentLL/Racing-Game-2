/**
 * Subaru Impreza Rally (GC8 phase 2, 1999 WRC) — 4-door rally sedan.
 *
 * Distinctive features:
 *   - 4-door sedan silhouette (NOT hatchback)
 *   - Rectangular center hood scoop (intercooler)
 *   - Large GT rear wing extending past the body
 *   - Wide rally fenders
 *   - Round "bugeye" headlights
 *   - Small horizontal taillights at rear corners + antenna
 *
 * Ported from monolith L37884–38112.
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
  ctx.moveTo(-hl, -hw * 0.70);
  ctx.lineTo(-hl + L * 0.04, -hw * 0.92);
  ctx.lineTo(-hl + L * 0.12, -hw);
  ctx.lineTo(-hl + L * 0.28, -hw);
  ctx.lineTo(-hl + L * 0.32, -hw * 0.96);
  ctx.lineTo(hl - L * 0.30, -hw * 0.96);
  ctx.lineTo(hl - L * 0.26, -hw);
  ctx.lineTo(hl - L * 0.14, -hw);
  ctx.lineTo(hl - L * 0.04, -hw * 0.88);
  ctx.quadraticCurveTo(hl, -hw * 0.56, hl, -hw * 0.28);
  ctx.quadraticCurveTo(hl + 0.2, -hw * 0.10, hl + 0.2, 0);
  ctx.quadraticCurveTo(hl + 0.2, hw * 0.10, hl, hw * 0.28);
  ctx.quadraticCurveTo(hl, hw * 0.56, hl - L * 0.04, hw * 0.88);
  ctx.lineTo(hl - L * 0.14, hw);
  ctx.lineTo(hl - L * 0.26, hw);
  ctx.lineTo(hl - L * 0.30, hw * 0.96);
  ctx.lineTo(-hl + L * 0.32, hw * 0.96);
  ctx.lineTo(-hl + L * 0.28, hw);
  ctx.lineTo(-hl + L * 0.12, hw);
  ctx.lineTo(-hl + L * 0.04, hw * 0.92);
  ctx.lineTo(-hl, hw * 0.70);
  ctx.closePath();
}

export const IMPREZA_GC8: GenerationRenderer = {
  id: 'impreza_gc8',

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

    // Rally fender flares.
    ctx.fillStyle = darken(color, 0.25);
    ctx.fillRect(-hl + L * 0.10, -hw * 0.96, L * 0.22, hw * 0.16);
    ctx.fillRect(-hl + L * 0.10,  hw * 0.80, L * 0.22, hw * 0.16);
    ctx.fillRect(hl - L * 0.32,  -hw * 0.96, L * 0.22, hw * 0.16);
    ctx.fillRect(hl - L * 0.32,   hw * 0.80, L * 0.22, hw * 0.16);

    // Trunk deck.
    ctx.fillStyle = darken(color, 0.12);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.74, hl * 0.55, hw * 1.48);

    // Hood.
    ctx.fillStyle = lighten(color, 0.15);
    ctx.fillRect(hl * 0.12, -hw * 0.50, hl * 0.78, hw * 1.00);

    // Roof (brightest).
    ctx.fillStyle = lighten(color, 0.22);
    ctx.fillRect(-hl * 0.28, -hw * 0.58, hl * 0.48, hw * 1.16);

    // Edge rim.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = darken(color, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Impreza signature hood scoop.
    ctx.fillStyle = darken(color, 0.55);
    ctx.fillRect(hl * 0.35, -hw * 0.28, L * 0.16, hw * 0.56);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(hl * 0.37, -hw * 0.24, L * 0.12, hw * 0.48);
    ctx.strokeStyle = lighten(color, 0.25);
    ctx.lineWidth = 0.3;
    ctx.strokeRect(hl * 0.35, -hw * 0.28, L * 0.16, hw * 0.56);

    // Windshield + wipers.
    const wsBack = hl * 0.08;
    const wsFront = hl * 0.26;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(wsBack,  -hw * 0.58);
    ctx.lineTo(wsFront, -hw * 0.44);
    ctx.lineTo(wsFront,  hw * 0.44);
    ctx.lineTo(wsBack,   hw * 0.58);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.4;
    ctx.beginPath(); ctx.moveTo(wsBack + 1.2, -hw * 0.26); ctx.lineTo(wsFront - 0.5, -hw * 0.08); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wsBack + 1.2,  hw * 0.08); ctx.lineTo(wsFront - 0.5,  hw * 0.26); ctx.stroke();

    // Rear window.
    const rwFront = -hl * 0.08;
    const rwBack  = -hl * 0.30;
    ctx.fillStyle = '#0a1320';
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.52);
    ctx.lineTo(rwBack,  -hw * 0.40);
    ctx.lineTo(rwBack,   hw * 0.40);
    ctx.lineTo(rwFront,  hw * 0.52);
    ctx.closePath();
    ctx.fill();

    // Roof panel.
    ctx.fillStyle = lighten(color, 0.10);
    ctx.beginPath();
    ctx.moveTo(rwFront, -hw * 0.50);
    ctx.lineTo(wsBack,  -hw * 0.56);
    ctx.lineTo(wsBack,   hw * 0.56);
    ctx.lineTo(rwFront,  hw * 0.50);
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

    // Door + trunk shut lines.
    ctx.strokeStyle = darken(color, 0.35);
    ctx.lineWidth = 0.35;
    ctx.beginPath(); ctx.moveTo(hl * 0.06,  -hw * 0.92); ctx.lineTo(hl * 0.06,   hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.32, -hw * 0.92); ctx.lineTo(-hl * 0.32,  hw * 0.92); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-hl * 0.42, -hw * 0.75); ctx.lineTo(-hl * 0.42,  hw * 0.75); ctx.stroke();

    // Specular.
    ctx.fillStyle = lighten(color, 0.50);
    ctx.fillRect(hl * 0.55, -hw * 0.05, 1.2, 0.8);

    ctx.restore(); // end clip

    // Mirrors.
    ctx.fillStyle = darken(color, 0.40);
    ctx.fillRect(hl * 0.10, -hw * 0.98 - 1.1, 1.4, 1.3);
    ctx.fillRect(hl * 0.10,  hw * 0.98 - 0.2, 1.4, 1.3);
    ctx.fillStyle = 'rgba(165,185,210,0.5)';
    ctx.fillRect(hl * 0.10 + 0.3, -hw * 0.98 - 0.9, 0.7, 0.5);
    ctx.fillRect(hl * 0.10 + 0.3,  hw * 0.98,        0.7, 0.5);

    // Roof antenna (rally signature).
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(-hl * 0.22, -hw * 0.05, 0.5, 1.0);

    // Round bugeye headlights.
    const hlightX = hl - L * 0.03;
    if (nightFactor > 0.05) {
      ctx.fillStyle = '#fff5c8';
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.3, 0, Math.PI * 2); ctx.fill();
      const hg = 3.2 + nightFactor * 3.0;
      v2HeadlightGlow(ctx, hlightX, -hw * 0.52, hg, nightFactor * 0.45);
      v2HeadlightGlow(ctx, hlightX,  hw * 0.52, hg, nightFactor * 0.45);
    } else {
      ctx.fillStyle = darken(color, 0.25);
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.3, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = lighten(color, 0.3);
      ctx.lineWidth = 0.3;
      ctx.beginPath(); ctx.arc(hlightX - 0.5, -hw * 0.52, 1.3, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(hlightX - 0.5,  hw * 0.52, 1.3, 0, Math.PI * 2); ctx.stroke();
    }

    // Small horizontal taillights.
    const tlBright = isBraking ? '#ff5544' : (nightFactor > 0.05 ? '#ee2a15' : '#9a2010');
    ctx.fillStyle = tlBright;
    ctx.fillRect(-hl + L * 0.02, -hw * 0.82, 2.0, hw * 0.22);
    ctx.fillRect(-hl + L * 0.02,  hw * 0.60, 2.0, hw * 0.22);
    // Inner amber indicator.
    ctx.fillStyle = nightFactor > 0.05 ? '#ff9900' : '#8a4400';
    ctx.fillRect(-hl + L * 0.02, -hw * 0.58, 1.5, hw * 0.10);
    ctx.fillRect(-hl + L * 0.02,  hw * 0.48, 1.5, hw * 0.10);
    // Glow.
    if (isBraking || nightFactor > 0.05) {
      const tg = 3.0 + nightFactor * 2.5 + (isBraking ? 3 : 0);
      const ta = isBraking ? 0.55 : nightFactor * 0.35;
      const tc = isBraking ? '255,70,50' : '255,40,10';
      v2TaillightGlow(ctx, -hl + L * 0.06, -hw * 0.72, tg, ta, tc);
      v2TaillightGlow(ctx, -hl + L * 0.06,  hw * 0.70, tg, ta, tc);
    }

    // Big GT rear wing — main airfoil + lighter top edge + tall vertical endplates.
    ctx.fillStyle = darken(color, 0.45);
    ctx.fillRect(-hl + L * 0.06, -hw * 0.80, 1.5, hw * 1.60);
    ctx.fillStyle = lighten(color, 0.05);
    ctx.fillRect(-hl + L * 0.06, -hw * 0.80, 0.5, hw * 1.60);
    ctx.fillStyle = darken(color, 0.65);
    ctx.fillRect(-hl + L * 0.04, -hw * 0.82, 0.5, hw * 0.14);
    ctx.fillRect(-hl + L * 0.04,  hw * 0.68, 0.5, hw * 0.14);

    // Reverse lights.
    if (isReverse) {
      ctx.fillStyle = '#ffe8a0';
      ctx.fillRect(-hl + L * 0.02, -hw * 0.44, 1.8, 0.9);
      ctx.fillRect(-hl + L * 0.02,  hw * 0.34, 1.8, 0.9);
    }

    // Outline.
    tracePath(ctx, hl, hw, L, W);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = 0.6;
    ctx.stroke();
  },
};
